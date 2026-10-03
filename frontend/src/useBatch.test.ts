import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_BATCH_FILES } from "./batch";
import { useBatch } from "./useBatch";
import type { DetectOk } from "./types";

const OK = { score: 0.42, verdict: "uncertain", confidence: "medium", lang: "en", char_count: 900, paragraphs: [] } as unknown as DetectOk;
const files = [new File(["fixture"], "a.txt"), new File(["fixture"], "b.txt")];
const previewFn = async () => ({ text: "English synthetic fixture", char_count: 100, paragraph_count: 1, truncated: false, language_hint: "en" as const });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("useBatch", () => {
  it("retries one failed file without resetting completed or edited results", async () => {
    let calls = 0;
    const detectFn = vi.fn(async () => ++calls === 2 ? { error: "temporary", message: "retry me" } : OK);
    const { result } = renderHook(() => useBatch({ previewFn, detectFn }));
    act(() => { result.current.setFiles(files); });
    await act(async () => { await result.current.start(); });
    const edited = { ...OK, score: 0.08 };
    act(() => { result.current.updateResult(0, edited); });
    await act(async () => { await result.current.retry(1); });
    expect(result.current.rows.map((row) => row.status)).toEqual(["done", "done"]);
    expect(result.current.rows[0].result).toBe(edited);
    expect(detectFn).toHaveBeenCalledTimes(3);
  });
  it("stops after the current file and continues only cancelled files", async () => {
    const active = deferred<DetectOk>();
    const detectFn = vi.fn().mockImplementationOnce(() => active.promise).mockResolvedValue(OK);
    const { result } = renderHook(() => useBatch({ previewFn, detectFn }));
    act(() => { result.current.setFiles(files); });
    let running!: Promise<void>;
    await act(async () => { running = result.current.start(); await Promise.resolve(); });
    act(() => { result.current.cancel(); });
    expect(result.current.stopping).toBe(true);
    await act(async () => { active.resolve(OK); await running; });
    expect(result.current.rows.map((row) => row.status)).toEqual(["done", "cancelled"]);
    const first = result.current.rows[0].result;
    await act(async () => { await result.current.start(); });
    expect(result.current.rows.map((row) => row.status)).toEqual(["done", "done"]);
    expect(result.current.rows[0].result).toBe(first);
    expect(detectFn).toHaveBeenCalledTimes(2);
  });
  it("preserves mixed-language edits", async () => {
    const mixed = { lang: "bi" as const, note: "fixture", disclaimer: "fixture", en: OK, zh: { ...OK, lang: "zh" as const } };
    const { result } = renderHook(() => useBatch({ previewFn, detectFn: async () => mixed }));
    act(() => { result.current.setFiles(files); });
    await act(async () => { await result.current.start(); });
    const edited = { ...mixed, zh: { ...mixed.zh, score: 0.1 } };
    act(() => { result.current.updateResult(0, edited); });
    expect(result.current.rows[0].result).toBe(edited);
  });
  it("rejects over-limit selection intact and retains previous files and results", async () => {
    const { result } = renderHook(() => useBatch({ previewFn, detectFn: async () => OK }));
    act(() => { result.current.setFiles(files); });
    await act(async () => { await result.current.start(); });
    let accepted!: boolean;
    act(() => { accepted = result.current.setFiles(Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => new File(["fixture"], `${i}.txt`))); });
    expect(accepted).toBe(false);
    expect(result.current.files).toEqual(files);
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.selectionError).toContain("21 个文件");
    expect(result.current.selectionError).toContain("本次选择未添加");
  });
  it("ignores late results from a replaced batch", async () => {
    const old = deferred<DetectOk>();
    const { result } = renderHook(() => useBatch({ previewFn, detectFn: async () => old.promise }));
    act(() => { result.current.setFiles(files); });
    let running!: Promise<void>;
    await act(async () => { running = result.current.start(); await Promise.resolve(); });
    act(() => { result.current.setFiles([new File(["new fixture"], "new.txt")]); });
    await act(async () => { old.resolve(OK); await running; });
    expect(result.current.files[0].name).toBe("new.txt");
    expect(result.current.rows).toEqual([]);
    expect(result.current.running).toBe(false);
  });

  it("lets unrecognised files be retried with a manual language while completed edits stay intact", async () => {
    const detectFn = vi.fn(async () => OK);
    const { result } = renderHook(() => useBatch({ detectFn, previewFn: async (file) => ({
      ...await previewFn(), language_hint: file.name === "b.txt" ? null : "en" as const,
    }) }));
    act(() => { result.current.setFiles(files); });
    await act(async () => { await result.current.start(); });
    const edited = { ...OK, score: 0.08 };
    act(() => { result.current.updateResult(0, edited); result.current.setLanguage(0, "zh"); result.current.setLanguage(1, "en"); });
    expect(result.current.rows[0].languageOverride).toBeUndefined();
    expect(result.current.rows[1].languageOverride).toBe("en");
    await act(async () => { await result.current.retry(1); });
    expect(result.current.rows.map((row) => row.status)).toEqual(["done", "done"]);
    expect(result.current.rows[0].result).toBe(edited);
    expect(detectFn).toHaveBeenCalledTimes(2);
  });
});
