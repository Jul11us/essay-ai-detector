import { describe, expect, it } from "vitest";
import { ALL_FILTERS, filterRecords, importedRecords, matchSampleFiles, parseManifest, rate, recordMetrics } from "./evaluation";
import type { EvaluationRecord, Sample } from "./evaluation";

const record = (id: string, updates: Partial<EvaluationRecord> = {}): EvaluationRecord => ({ id, lang: "en", label: "human", source: "fixture", split: "test", group_id: id,
  score: .1, verdict: "low", confidence: "medium", model_id: "fixture-model", model_revision: "fixture-version", char_count: 500, word_count: 80, ...updates });

describe("evaluation import and metrics", () => {
  it("does not trust imported summary metrics and preserves incomplete-run denominator", () => {
    const rows = [record("a")];
    expect(importedRecords({ records: rows, overall: { accuracy: 1 }, evaluation_run: { expected: 2 } })).toEqual({ records: rows, expected: 2 });
    expect(importedRecords({ report: { records: rows } }).records).toEqual(rows);
    expect(() => importedRecords({ overall: { n: 2 } })).toThrow("records");
  });
  it("parses canonical JSONL and JSON arrays including a UTF-8 BOM", () => {
    expect(parseManifest('\uFEFF{"id":"a"}\n{"id":"b"}\n')).toEqual([{ id: "a" }, { id: "b" }]);
    expect(parseManifest('[{"id":"a"}]')).toEqual([{ id: "a" }]);
    expect(() => parseManifest("not JSON")).toThrow();
  });
  it("matches a canonical manifest path by unique basename but rejects ambiguity", () => {
    const sample = { id: "a", file: "samples/a.txt" } as Sample;
    const file = new File(["synthetic fixture"], "a.txt");
    expect(matchSampleFiles([sample], [file])).toEqual([file]);
    expect(() => matchSampleFiles([sample], [file, new File(["other"], "a.txt")])).toThrow("重名");
    expect(() => matchSampleFiles([sample], [])).toThrow("未找到");
  });
  it("separates uncertainty from errors and excludes mixed labels from binary denominators", () => {
    const result = recordMetrics([record("h"), record("a", { label: "ai", verdict: "uncertain" }), record("m", { label: "mixed", verdict: "low" })]);
    expect(result.humanFalseFlag).toMatchObject({ count: 0, of: 1 });
    expect(result.aiMiss).toMatchObject({ count: 0, of: 1 });
    expect(result.aiUncertain).toMatchObject({ count: 1, of: 1 });
    expect(rate(0, 0).wilson_ci).toBeNull();
    expect(rate(0, 30).wilson_ci?.[1]).toBeCloseTo(.113513, 5);
  });
  it("combines source, language, split, writer and length filters", () => {
    const rows = [record("a"), record("b", { lang: "zh", source: "second", char_count: 200 }), record("c", { split: "calibration" })];
    expect(filterRecords(rows, { ...ALL_FILTERS, split: "test", lang: "zh", length: "under_400_chars", source: "second" }).map((r) => r.id)).toEqual(["b"]);
  });
});
