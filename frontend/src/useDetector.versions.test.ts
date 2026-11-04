import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detect, detectSentences } from "./api";
import type { SentenceScan } from "./api";
import type { DetectOk } from "./types";
import { useDetector } from "./useDetector";
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  detect: vi.fn(),
  detectSentences: vi.fn(),
  fetchExplain: vi.fn(),
}));
const original = {
  lang: "en",
  model_id: "fixture",
  model_revision: "v1",
  score: 0.2,
  paragraphs: [
    {
      index: 0,
      text: "Original sentence.",
      excerpt: "Original sentence.",
      score: 0.2,
      char_count: 120,
      verdict: "low",
      sentences: [
        {
          text: "Original sentence.",
          score: 0.2,
          verdict: "low",
          highlight: null,
          review: { state: "reviewed", note: "Original review", updated_at: "now" },
        },
      ],
    },
  ],
} as DetectOk;
beforeEach(() => vi.clearAllMocks());
describe("version restoration and model consistency", () => {
  it("retains the document when a paragraph recheck returns a different model revision", async () => {
    vi.mocked(detect).mockResolvedValue({ ...original, model_revision: "v2" });
    const { result } = renderHook(useDetector);
    act(() => result.current.adopt(original));
    let error: string | null = null;
    await act(async () => {
      error = await result.current.recheck("single", original, 0, "Rewritten sentence.");
    });
    expect(error).toContain("模型版本已变化");
    expect((result.current.result as DetectOk).paragraphs[0].text).toBe("Original sentence.");
    expect(result.current.result?.version_history).toHaveLength(1);
  });
  it("restores saved scores and annotations without accepting a stale sentence response", async () => {
    let release!: (scan: SentenceScan) => void;
    vi.mocked(detectSentences).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(useDetector);
    act(() => result.current.adopt(original));
    const version = result.current.result!.version_history![0].id;
    act(() =>
      result.current.reviewSentence("single", 0, 0, "Original sentence.", {
        state: "revise",
        note: "New review",
        updated_at: "later",
      }),
    );
    act(() => result.current.saveVersion("New annotations"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.scan("single", result.current.result as DetectOk, 0);
    });
    act(() => result.current.restoreVersion(version));
    await act(async () => {
      release({
        sentences: [
          { text: "Original sentence.", score: 0.95, verdict: "high", highlight: "high" },
        ],
        capped: false,
        note: "",
      });
      await pending;
    });
    const restored = result.current.result as DetectOk;
    expect(restored.score).toBe(0.2);
    expect(restored.paragraphs[0].sentences![0].score).toBe(0.2);
    expect(restored.paragraphs[0].sentences![0].review?.note).toBe("Original review");
    expect(JSON.stringify(restored.version_history)).toContain("New review");
    expect(restored.writing_process!.events.map((event) => event.kind)).toEqual([
      "initial",
      "review",
      "manual",
      "checkpoint",
      "restore",
    ]);
    expect(
      restored.writing_process!.events.find((event) => event.kind === "review")!.review!.note,
    ).toBe("New review");
    expect(detect).not.toHaveBeenCalled();
  });
});
