import { describe, expect, it } from "vitest";
import { initialRows, runBatch, type BatchRow } from "./batch";
import { buildBatchCsv } from "./export";
import type { DetectOk } from "./types";

const OK = {
  score: 0.42,
  verdict: "uncertain",
  confidence: "medium",
  lang: "en",
  char_count: 900,
  paragraphs: [],
} as unknown as DetectOk;

const file = (name: string) => new File(["x"], name);

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
  it("runs files one at a time, in order, and keeps each result", async () => {
    const c = collect();
    let active = 0;
    let peak = 0;
    await runBatch([file("a.txt"), file("b.txt")], "en", c.onRow, new AbortController().signal, {
      detectFn: async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return OK;
      },
    });
    expect(peak).toBe(1);
    expect(c.history).toEqual(["0:running", "0:done", "1:running", "1:done"]);
    expect(c.rows[1].result?.score).toBe(0.42);
  });

  it("records a server error for one file and carries on with the next", async () => {
    const c = collect();
    let n = 0;
    await runBatch([file("bad.pdf"), file("good.txt")], "en", c.onRow, new AbortController().signal, {
      detectFn: async () =>
        n++ === 0 ? { error: "scanned_pdf", message: "扫描件" } : OK,
    });
    expect(c.rows[0]).toMatchObject({ status: "error", message: "扫描件" });
    expect(c.rows[1].status).toBe("done");
  });

  it("turns a thrown request failure into a row error", async () => {
    const c = collect();
    await runBatch([file("a.txt")], "zh", c.onRow, new AbortController().signal, {
      detectFn: async () => {
        throw new Error("network");
      },
    });
    expect(c.rows[0]).toMatchObject({ status: "error", message: "本机推理失败，未生成分数。" });
  });

  it("marks the running file and every later file as cancelled", async () => {
    const c = collect();
    const ctrl = new AbortController();
    await runBatch([file("a.txt"), file("b.txt"), file("c.txt")], "en", c.onRow, ctrl.signal, {
      detectFn: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
          queueMicrotask(() => ctrl.abort());
        }),
    });
    expect(c.rows.map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("gives up on a file that takes too long but still tries the next one", async () => {
    const c = collect();
    let n = 0;
    await runBatch([file("slow.txt"), file("fast.txt")], "en", c.onRow, new AbortController().signal, {
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
});

describe("initialRows / buildBatchCsv", () => {
  it("starts every file queued", () => {
    expect(initialRows([file("a.txt")])).toEqual([{ name: "a.txt", status: "queued" }]);
  });

  it("summarises one row per file, keeping the reason for failures", () => {
    const csv = buildBatchCsv([
      { name: "a.txt", status: "done", result: OK },
      { name: "=evil.pdf", status: "error", message: "扫描件, 无法读取" },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("file,status,language,score,verdict,confidence,characters,message");
    expect(lines[1]).toBe("a.txt,done,en,0.42,uncertain,medium,900,");
    expect(lines[2]).toBe("'=evil.pdf,error,,,,,,\"扫描件, 无法读取\"");
  });
});
