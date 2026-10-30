import { describe, expect, it, vi } from "vitest";
import { batchParts, initialRows, runBatch, type BatchRow } from "./batch";
import { buildBatchCsv } from "./export";
import type { BilingualOk, DetectOk } from "./types";

const OK = {
  score: 0.42,
  verdict: "uncertain",
  confidence: "medium",
  lang: "en",
  char_count: 900,
  paragraphs: [],
} as unknown as DetectOk;
const ZH = { ...OK, lang: "zh", score: 0.7 } as DetectOk;
const BI: BilingualOk = { lang: "bi", note: "分开计分", disclaimer: "模型估计", en: OK, zh: ZH };
const file = (name: string) => new File(["synthetic fixture"], name);
const previewFn = async () => ({
  text: "English fixture text for checking automatic language recognition.",
  char_count: 100,
  paragraph_count: 1,
  truncated: false,
});

function collect() {
  const rows: BatchRow[] = [];
  const history: string[] = [];
  return {
    rows,
    history,
    onRow: (i: number, row: BatchRow) => {
      rows[i] = row;
      history.push(`${i}:${row.status}`);
    },
  };
}

describe("runBatch", () => {
  it("previews and detects one file at a time in order", async () => {
    const c = collect();
    let active = 0,
      peak = 0;
    await runBatch([file("a.txt"), file("b.txt")], c.onRow, new AbortController().signal, {
      previewFn,
      detectFn: async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return OK;
      },
    });
    expect(peak).toBe(1);
    expect(c.history).toEqual([
      "0:running",
      "0:running",
      "0:done",
      "1:running",
      "1:running",
      "1:done",
    ]);
    expect(batchParts(c.rows[1].result)[0].score).toBe(0.42);
  });

  it("recognises every file separately and accepts mixed-language results", async () => {
    const c = collect();
    const detectFn = vi.fn(async (args: { lang: string }) =>
      args.lang === "bi" ? BI : args.lang === "zh" ? ZH : OK,
    );
    const languages = ["en", "zh", "bi"] as const;
    let n = 0;
    await runBatch(
      [file("english.txt"), file("chinese.txt"), file("mixed.txt")],
      c.onRow,
      new AbortController().signal,
      {
        previewFn: async () => ({ ...(await previewFn()), language_hint: languages[n++] }),
        detectFn,
      },
    );
    expect(detectFn.mock.calls.map(([args]) => args.lang)).toEqual(languages);
    expect(c.rows.map((row) => row.status)).toEqual(["done", "done", "done"]);
    expect(c.rows[2].result).toBe(BI);
  });

  it("trusts the full-text language hint even when the visible preview is truncated", async () => {
    const c = collect();
    const detectFn = vi.fn(async () => BI);
    await runBatch([file("mixed.txt")], c.onRow, new AbortController().signal, {
      previewFn: async () => ({ ...(await previewFn()), truncated: true, language_hint: "bi" }),
      detectFn,
    });
    expect(detectFn).toHaveBeenCalledWith(
      expect.objectContaining({ lang: "bi" }),
      expect.any(AbortSignal),
    );
  });

  it("keeps a successful bilingual section when the other section fails", async () => {
    const c = collect();
    await runBatch([file("mixed.txt")], c.onRow, new AbortController().signal, {
      previewFn,
      detectFn: async () => ({ ...BI, zh: { error: "not_ready", message: "中文模型未就绪" } }),
    });
    expect(c.rows[0]).toMatchObject({ status: "error", message: "中文：中文模型未就绪" });
    expect(batchParts(c.rows[0].result)).toEqual([OK]);
  });

  it("records preview errors without inference and continues with the next file", async () => {
    const c = collect();
    let n = 0;
    const detectFn = vi.fn(async () => OK);
    await runBatch([file("bad.pdf"), file("good.txt")], c.onRow, new AbortController().signal, {
      previewFn: async () =>
        n++ === 0 ? { error: "scanned_pdf", message: "扫描件" } : previewFn(),
      detectFn,
    });
    expect(c.rows[0]).toMatchObject({ status: "error", message: "扫描件" });
    expect(c.rows[1].status).toBe("done");
    expect(detectFn).toHaveBeenCalledTimes(1);
  });

  it("does not silently guess a language for an unrecognised file", async () => {
    const c = collect();
    const detectFn = vi.fn(async () => OK);
    await runBatch([file("unknown.txt")], c.onRow, new AbortController().signal, {
      previewFn: async () => ({ ...(await previewFn()), language_hint: null }),
      detectFn,
    });
    expect(c.rows[0].status).toBe("error");
    expect(c.rows[0].message).toContain("无法自动识别");
    expect(detectFn).not.toHaveBeenCalled();
  });

  it("turns a thrown request failure into a row error", async () => {
    const c = collect();
    await runBatch([file("a.txt")], c.onRow, new AbortController().signal, {
      previewFn,
      detectFn: async () => {
        throw new Error("network");
      },
    });
    expect(c.rows[0]).toMatchObject({
      status: "error",
      message: "文件提取或本机推理失败，可重试此文件。",
    });
  });

  it("uses a per-file manual language when automatic recognition is unavailable", async () => {
    const c = collect();
    const detectFn = vi.fn(async () => OK);
    await runBatch([file("unknown.txt")], c.onRow, new AbortController().signal, {
      previewFn: async () => ({ ...(await previewFn()), language_hint: null }),
      detectFn,
      languageOverrides: { 0: "en" },
    });
    expect(c.rows[0].status).toBe("done");
    expect(detectFn).toHaveBeenCalledWith(
      expect.objectContaining({ lang: "en" }),
      expect.any(AbortSignal),
    );
  });

  it("stops later files while keeping the current file's completed result", async () => {
    const c = collect();
    let stopped = false;
    const detectFn = vi.fn(async () => {
      stopped = true;
      return OK;
    });
    await runBatch(
      [file("a.txt"), file("b.txt"), file("c.txt")],
      c.onRow,
      new AbortController().signal,
      {
        previewFn,
        detectFn,
        stopAfterCurrent: () => stopped,
      },
    );
    expect(c.rows.map((row) => row.status)).toEqual(["done", "cancelled", "cancelled"]);
    expect(detectFn).toHaveBeenCalledTimes(1);
  });

  it("aborts the active file when the batch is replaced", async () => {
    const c = collect();
    const ctrl = new AbortController();
    await runBatch([file("a.txt"), file("b.txt")], c.onRow, ctrl.signal, {
      previewFn,
      detectFn: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
          queueMicrotask(() => ctrl.abort());
        }),
    });
    expect(c.rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("gives up on a slow file but still tries the next one", async () => {
    const c = collect();
    let n = 0;
    await runBatch([file("slow.txt"), file("fast.txt")], c.onRow, new AbortController().signal, {
      previewFn,
      timeoutMs: 5,
      detectFn: (_args, signal) =>
        n++ === 0
          ? new Promise((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(new Error("aborted"))),
            )
          : Promise.resolve(OK),
    });
    expect(c.rows[0].status).toBe("error");
    expect(c.rows[0].message).toContain("10 分钟");
    expect(c.rows[1].status).toBe("done");
  });

  it("retries just the requested original index", async () => {
    const c = collect();
    const detectFn = vi.fn(async () => OK);
    await runBatch(
      [file("a.txt"), file("b.txt"), file("c.txt")],
      c.onRow,
      new AbortController().signal,
      {
        previewFn,
        detectFn,
        indices: [1],
      },
    );
    expect(detectFn).toHaveBeenCalledTimes(1);
    expect(c.rows[0]).toBeUndefined();
    expect(c.rows[1]).toMatchObject({ name: "b.txt", status: "done" });
    expect(c.rows[2]).toBeUndefined();
  });
});

describe("initialRows / buildBatchCsv", () => {
  it("starts every file queued", () => {
    expect(initialRows([file("a.txt")])).toEqual([{ name: "a.txt", status: "queued" }]);
  });

  it("exports per-file scores, escaping names and preserving failure reasons", () => {
    const lines = buildBatchCsv([
      { name: "a.txt", status: "done", result: OK },
      { name: "=evil.pdf", status: "error", message: "扫描件, 无法读取" },
    ])
      .trimEnd()
      .split("\r\n");
    expect(lines[0]).toBe("file,status,language,score,verdict,confidence,characters,message");
    expect(lines[1]).toBe("a.txt,done,en,0.42,uncertain,medium,900,");
    expect(lines[2]).toBe('\'=evil.pdf,error,,,,,,"扫描件, 无法读取"');
  });

  it("exports mixed files as separate language rows including section failures", () => {
    const lines = buildBatchCsv([
      {
        name: "mixed.txt",
        status: "error",
        result: {
          ...BI,
          zh: { error: "not_ready", message: "中文模型未就绪" },
        },
      },
    ])
      .trimEnd()
      .split("\r\n");
    expect(lines).toEqual([
      "file,status,language,score,verdict,confidence,characters,message",
      "mixed.txt,done,en,0.42,uncertain,medium,900,",
      "mixed.txt,error,zh,,,,,中文模型未就绪",
    ]);
  });
});
