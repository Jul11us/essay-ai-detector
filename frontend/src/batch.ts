import { detect, isDetectErr, previewFile, type DetectResult, type FilePreview } from "./api";
import type { Outcome } from "./aggregate";
import { suggestLanguage } from "./languageHint";
import type { DetectErr, DetectOk, Lang } from "./types";
import { isBilingual, isSectionErr } from "./types";

export const MAX_BATCH_FILES = 20;
export const BATCH_FILE_TIMEOUT_MS = 10 * 60 * 1000;

export type BatchStatus = "queued" | "running" | "done" | "error" | "cancelled";

export type BatchRow = {
  name: string;
  status: BatchStatus;
  lang?: Lang;
  languageOverride?: Lang;
  result?: Outcome;
  message?: string;
};

type DetectFn = (
  args: { lang: Lang; text: string; file: File | null },
  signal?: AbortSignal,
) => Promise<DetectResult>;

export type RunBatchOptions = {
  detectFn?: DetectFn;
  previewFn?: (file: File, signal?: AbortSignal) => Promise<FilePreview | DetectErr>;
  timeoutMs?: number;
  /** 仅处理指定行。回调仍使用原文件序号，完成的结果不会重新计算。 */
  indices?: number[];
  languageOverrides?: Record<number, Lang>;
  /** 取消后续文件时，让当前文件完成，再取消尚未开始的文件。 */
  stopAfterCurrent?: () => boolean;
};

export function initialRows(files: File[]): BatchRow[] {
  return files.map((f) => ({ name: f.name, status: "queued" }));
}

export function batchParts(result: Outcome | undefined): DetectOk[] {
  if (!result) return [];
  return isBilingual(result)
    ? [result.en, result.zh].filter((part): part is DetectOk => Boolean(part && !isSectionErr(part)))
    : [result];
}

/** 逐个提取和检测，每篇自动识别语言，单篇失败不会阻断后续文件。 */
export async function runBatch(
  files: File[],
  onRow: (index: number, row: BatchRow) => void,
  signal: AbortSignal,
  options: RunBatchOptions = {},
): Promise<void> {
  const detectFn = options.detectFn ?? detect;
  const previewFn = options.previewFn ?? previewFile;
  const timeoutMs = options.timeoutMs ?? BATCH_FILE_TIMEOUT_MS;
  const indices = options.indices ?? files.map((_, i) => i);
  for (const i of indices) {
    const name = files[i].name;
    if (signal.aborted || options.stopAfterCurrent?.()) {
      onRow(i, { name, status: "cancelled", message: "尚未检测，可继续或单独重试。" });
      continue;
    }
    onRow(i, { name, status: "running", message: "正在提取文字并识别语言…" });
    const ctrl = new AbortController();
    const forward = () => ctrl.abort();
    signal.addEventListener("abort", forward);
    let timedOut = false;
    let lang: Lang | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const preview = await previewFn(files[i], ctrl.signal);
      if (ctrl.signal.aborted) throw new Error("aborted");
      if (isDetectErr(preview)) {
        onRow(i, { name, status: "error", message: preview.message });
        continue;
      }
      const hint = options.languageOverrides?.[i] ??
        ("language_hint" in preview ? preview.language_hint : suggestLanguage(preview.text));
      if (!hint) {
        onRow(i, { name, status: "error", message: "无法自动识别语言。请在本行选择中文、英文或中英分开，再重试。" });
        continue;
      }
      lang = hint;
      onRow(i, { name, status: "running", lang, message: "正在检测…" });
      const data = await detectFn({ lang, text: "", file: files[i] }, ctrl.signal);
      if (ctrl.signal.aborted) throw new Error("aborted");
      if (isDetectErr(data)) {
        onRow(i, { name, status: "error", lang, message: data.message });
      } else if (isBilingual(data)) {
        const errors = (["en", "zh"] as const).flatMap((side) => {
          const part = data[side];
          return part && isSectionErr(part) ? [`${side === "en" ? "英文" : "中文"}：${part.message}`] : [];
        });
        const hasScore = batchParts(data).length > 0;
        onRow(i, {
          name,
          status: errors.length || !hasScore ? "error" : "done",
          lang: data.lang,
          result: data,
          message: errors.join("；") || (hasScore ? undefined : "这个文件没有可评分的中英文正文。"),
        });
      } else {
        onRow(i, { name, status: "done", lang: data.lang, result: data });
      }
    } catch {
      onRow(i, {
        name,
        status: signal.aborted ? "cancelled" : "error",
        lang,
        message: timedOut ? "超过 10 分钟已自动取消，可重试此文件。" : signal.aborted
          ? "已取消，可重新检测。" : "文件提取或本机推理失败，可重试此文件。",
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    }
  }
}
