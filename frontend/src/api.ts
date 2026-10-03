import type { BilingualOk, DetectErr, DetectOk, Lang, Status } from "./types";
import type { Rhythm, MarkerHit, SentenceHit } from "./types";

export async function fetchStatus(): Promise<Status> {
  const r = await fetch("/api/status");
  if (!r.ok) throw new Error("status");
  return r.json();
}

export type FilePreview = {
  blocks?: { index: number; text: string; section: string; char_count: number }[];
  source_sha256?: string;
  scope_available?: boolean;
  text: string;
  char_count: number;
  paragraph_count: number;
  truncated: boolean;
  /** 全文的语言提示；旧服务未提供时使用预览文字。 */
  language_hint?: Lang | null;
};

export async function previewFile(file: File, signal?: AbortSignal): Promise<FilePreview | DetectErr> {
  const fd = new FormData();
  fd.set("file", file);
  const r = await fetch("/api/preview", { method: "POST", body: fd, signal });
  return r.json() as Promise<FilePreview | DetectErr>;
}

export type DetectResult = DetectOk | BilingualOk | DetectErr;

export async function detect(
  args: {
    lang: Lang;
    text: string;
    file: File | null;
    en?: string;
    zh?: string;
    /** 只重测一段时放宽整篇的最短长度。 */
    scope?: "paragraph";
    selection?: number[];
    source_sha256?: string;
  },
  signal?: AbortSignal,
): Promise<DetectResult> {
  let r: Response;
  if (args.file) {
    const fd = new FormData();
    fd.set("lang", args.lang);
    fd.set("file", args.file);
    if (args.selection !== undefined) {
      fd.set("selection", JSON.stringify(args.selection));
      fd.set("source_sha256", args.source_sha256 ?? "");
    }
    r = await fetch("/api/detect", { method: "POST", body: fd, signal });
  } else {
    r = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang: args.lang,
        text: args.text,
        en: args.en ?? "",
        zh: args.zh ?? "",
        scope: args.scope,
      }),
      signal,
    });
  }
  return r.json() as Promise<DetectResult>;
}

export type SentenceScan = {
  sentences: SentenceHit[];
  capped: boolean;
  note: string;
};

export async function detectSentences(
  args: {
    lang: "zh" | "en";
    text: string;
  },
  signal?: AbortSignal,
): Promise<SentenceScan | DetectErr> {
  const r = await fetch("/api/sentences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal,
  });
  return r.json() as Promise<SentenceScan | DetectErr>;
}

export async function fetchExplain(args: {
  lang: "zh" | "en";
  text: string;
}): Promise<{ markers: MarkerHit[]; rhythm: Rhythm } | DetectErr> {
  const r = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return r.json() as Promise<{ markers: MarkerHit[]; rhythm: Rhythm } | DetectErr>;
}

export function isDetectErr(
  x: DetectResult | SentenceScan | FilePreview | { markers: MarkerHit[]; rhythm: Rhythm },
): x is DetectErr {
  return "error" in x && !("score" in x) && !("sentences" in x) && !("markers" in x);
}
