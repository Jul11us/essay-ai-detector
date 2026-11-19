import { describe, expect, it } from "vitest";
import { assessProcess } from "./processEvidence";
import type { BilingualOk, DetectOk, Verdict } from "./types";
import { appendVersion, ensureVersions, recordRecheck } from "./versions";

const body = "On our way back from the lake, we compared the route on the paper map with the path we had walked. ".repeat(3).trim();
const addition = " We stopped on the footbridge to sketch the bend in the river and mark the place where the trail became too muddy to follow.".repeat(3);
const doc = (text: string, verdict: Verdict = "high"): DetectOk => ({
  lang: "en", score: .95, verdict, model_id: "fixture",
  paragraphs: [{ index: 0, text, excerpt: text.slice(0, 20), verdict, score: .95, char_count: text.length }],
} as DetectOk);
const recheck = (previous: DetectOk, text: string, verdict?: Verdict) => recordRecheck(previous, doc(text, verdict), "第 1 段重测");

describe("assessProcess", () => {
  it("does not infer how a first draft arrived, or count duplicate saves and rescoring", () => {
    const original = ensureVersions(doc(body));
    const saved = appendVersion(original, "Saved draft", "manual", true);
    expect(assessProcess(recheck(recheck(saved, body), body), "en")).toEqual({ kind: "none" });
  });

  it.each([["high", "supports"], ["low", "review"], ["uncertain", "context"]] as const)(
    "reports a verified bulk addition with %s verdict as %s without changing the model result",
    (verdict, assessment) => {
      const result = recheck(ensureVersions(doc(body)), body + addition, verdict);
      const unchanged = structuredClone(result);
      expect(assessProcess(result, "en")).toEqual({ kind: "bulk", share: expect.closeTo(.56, 1), assessment });
      expect(result).toEqual(unchanged);
    },
  );

  it("distinguishes repeated edits from a single small change or wholesale rewrite", () => {
    const original = ensureVersions(doc(body));
    const first = body.replace("paper map", "hand-drawn map");
    const second = first.replace("the route", "our route");
    expect(assessProcess(recheck(original, first), "en")).toEqual({ kind: "none" });
    const saved = appendVersion(recheck(original, first), "First revision", "manual", true);
    expect(assessProcess(recheck(saved, second), "en")).toEqual({ kind: "revisions", count: 2, assessment: "diverges" });
    expect(assessProcess(recheck(saved, second, "low"), "en")).toEqual({ kind: "revisions", count: 2, assessment: "context" });
    expect(assessProcess(recheck(saved, addition.trim()), "en")).toEqual({ kind: "mixed", count: 2, assessment: "context" });
  });

  it("does not count unchanged text between two distant corrections as rewritten", () => {
    const source = "Thier plan was simple. " + body + " We returned to the libary.";
    const initial = ensureVersions(doc(source));
    const first = recheck(initial, source.replace("Thier", "Their").replace("libary", "library"));
    const second = recheck(first, first.paragraphs[0].text!.replace("simple", "straightforward"));
    expect(assessProcess(second, "en")).toEqual({ kind: "revisions", count: 2, assessment: "diverges" });
  });

  it("does not count gaps, snapshot-only legacy history, missing full text, or restores", () => {
    const original = ensureVersions(doc(body));
    const revised = recheck(original, body + addition);
    const restored = appendVersion({ ...revised, ...doc(body) }, "Restored", "restore", true);
    expect(assessProcess(restored, "en")).toEqual({ kind: "none" });
    const legacy = ensureVersions({ ...revised, writing_process: undefined });
    expect(assessProcess(legacy, "en")).toEqual({ kind: "none" });
    const versions = revised.version_history!;
    const gap = { ...revised, version_history: versions.slice(1) };
    expect(assessProcess(gap, "en")).toEqual({ kind: "none" });
    const excerpt = ensureVersions({ ...original, version_history: undefined, paragraphs: original.paragraphs.map((p) => ({ ...p, text: undefined })) });
    expect(assessProcess(recheck(excerpt, body + addition), "en")).toEqual({ kind: "none" });
  });

  it("does not transfer evidence to the unchanged language in a bilingual result", () => {
    const zh = { ...doc("出门前，我们看了地图。"), lang: "zh" } as const;
    const source = ensureVersions<BilingualOk>({ lang: "bi", en: doc(body), zh, note: "", disclaimer: "" });
    const revised = recordRecheck(source, { ...source, en: doc(body + addition) }, "英文第 1 段重测");
    expect(assessProcess(revised, "en")).toMatchObject({ kind: "bulk", assessment: "supports" });
    expect(assessProcess(revised, "zh")).toEqual({ kind: "none" });
  });
});
