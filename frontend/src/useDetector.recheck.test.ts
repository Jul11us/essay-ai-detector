import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detect, detectSentences, fetchExplain } from "./api";
import type { DetectOk, ParagraphHit } from "./types";
import { useDetector } from "./useDetector";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  detect: vi.fn(), detectSentences: vi.fn(), fetchExplain: vi.fn(),
}));

const sentence = { text: "Rewritten sentence.", score: .8, verdict: "high", highlight: "high" } as const;
function doc(sentences: ParagraphHit["sentences"]): DetectOk {
  return {
    lang: "en", model_id: "fixture", model_revision: "v1", score: .9,
    verdict: "high", confidence: "low", mixed_variance: false,
    char_count: 500, word_count: 100, basis: "", reading: "", explanation: "",
    review_risk: "likely_flag", review_label: "", review: "", disclaimer: "",
    paragraphs: [{ index: 0, text: sentence.text, excerpt: sentence.text,
      score: .9, verdict: "high", char_count: 500, sentences, sentenceNote: "Returned note" }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchExplain).mockRejectedValue(new Error("Feature review unavailable"));
});

describe("paragraph recheck sentence reuse", () => {
  it.each([{ sentences: [sentence] }, { sentences: [] }])("keeps returned sentence reviews without rescanning ($sentences)", async ({ sentences }) => {
    const returned = doc(sentences);
    vi.mocked(detect).mockResolvedValue(returned);
    const current = doc(null);
    const { result } = renderHook(useDetector);
    act(() => result.current.adopt(current));
    let error: string | null | undefined;
    await act(async () => { error = await result.current.recheck("single", current, 0, sentence.text); });
    expect(error).toBeNull();
    expect(detectSentences).not.toHaveBeenCalled();
    const paragraph = (result.current.result as DetectOk).paragraphs[0];
    expect(paragraph.sentences).toEqual(returned.paragraphs[0].sentences);
    expect(paragraph.sentenceNote).toBe("Returned note");
  });

  it.each([undefined, null])("scans when returned sentences are %s", async (sentences) => {
    vi.mocked(detect).mockResolvedValue(doc(sentences));
    vi.mocked(detectSentences).mockResolvedValue({ sentences: [sentence], note: "Scanned note", capped: false });
    const current = doc(null);
    const { result } = renderHook(useDetector);
    act(() => result.current.adopt(current));
    await act(async () => { await result.current.recheck("single", current, 0, sentence.text); });
    expect(detectSentences).toHaveBeenCalledExactlyOnceWith({ lang: "en", text: sentence.text });
    expect((result.current.result as DetectOk).paragraphs[0].sentences).toEqual([sentence]);
  });

  it("retains the paragraph score if fallback sentence inference fails", async () => {
    vi.mocked(detect).mockResolvedValue(doc(undefined));
    vi.mocked(detectSentences).mockRejectedValue(new Error("Inference unavailable"));
    const current = doc(null);
    const { result } = renderHook(useDetector);
    act(() => result.current.adopt(current));
    await act(async () => { await result.current.recheck("single", current, 0, sentence.text); });
    expect(detectSentences).toHaveBeenCalledTimes(1);
    const paragraph = (result.current.result as DetectOk).paragraphs[0];
    expect(paragraph.score).toBe(.9);
    expect(paragraph.sentences).toEqual([]);
    expect(paragraph.sentenceNote).toContain("逐句打分失败");
  });
});
