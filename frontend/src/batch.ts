import { detect, isDetectErr, type DetectResult } from "./api";
import type { DetectOk } from "./types";
import { isBilingual } from "./types";

export const MAX_BATCH_FILES = 20;
// 单个文件的兜底时限，和单篇检测一致。
export const BATCH_FILE_TIMEOUT_MS = 10 * 60 * 1000;

export type BatchStatus = "queued" | "running" | "done" | "error" | "cancelled";

export type BatchRow = {
  name: string;
  status: BatchStatus;
  result?: DetectOk;
  message?: string;
};

type DetectFn = (
  args: { lang: "zh" | "en"; text: string; file: File | null },
  signal?: AbortSignal,
) => Promise<DetectResult>;

export function initialRows(files: File[]): BatchRow[] {
  return files.map((f) => ({ name: f.name, status: "queued" }));
}

/**
 * 逐个文件检测。一次只跑一个：后端本来就一次只推理一个，并发提交只会让
 * 后面的文件白白占着连接排队。`signal` 是整批的取消；单个文件另有时限。
 * 某个文件失败不影响后面的文件。
 */
export async function runBatch(
  files: File[],
  lang: "zh" | "en",
  onRow: (index: number, row: BatchRow) => void,
  signal: AbortSignal,
  options: { detectFn?: DetectFn; timeoutMs?: number } = {},
): Promise<void> {
  const detectFn = options.detectFn ?? (detect as DetectFn);
  const timeoutMs = options.timeoutMs ?? BATCH_FILE_TIMEOUT_MS;
  for (let i = 0; i < files.length; i++) {
    const name = files[i].name;
    if (signal.aborted) {
      onRow(i, { name, status: "cancelled" });
      continue;
    }
    onRow(i, { name, status: "running" });
    const ctrl = new AbortController();
    const forward = () => ctrl.abort();
    signal.addEventListener("abort", forward);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const data = await detectFn({ lang, text: "", file: files[i] }, ctrl.signal);
      if (isDetectErr(data)) {
        onRow(i, { name, status: "error", message: data.message });
      } else if (isBilingual(data)) {
        onRow(i, { name, status: "error", message: "这个文件没有返回单一语言的分数。" });
      } else {
        onRow(i, { name, status: "done", result: data });
      }
    } catch {
      if (timedOut) {
        onRow(i, { name, status: "error", message: "超过 10 分钟已自动取消。" });
      } else if (signal.aborted) {
        onRow(i, { name, status: "cancelled" });
      } else {
        onRow(i, { name, status: "error", message: "本机推理失败，未生成分数。" });
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    }
  }
}
