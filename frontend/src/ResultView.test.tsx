import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { replaceParagraph } from "./aggregate";
import { ResultCard } from "./ResultView";
import type { DetectOk } from "./types";

describe("guard-adjusted result header", () => {
  it.each(["en", "zh"] as const)("shows the %s guard instead of short-text or middle-score reasons after detection and retesting", (lang) => {
    const paragraph = { index: 0, text: "Sentence.", excerpt: "Sentence.", char_count: 400,
      score: .92, verdict: "high" as const,
      sentences: [{ text: "Sentence.", score: .1, verdict: "low" as const, highlight: null }] };
    const data: DetectOk = {
      lang, score: .92, verdict: "uncertain", confidence: lang === "en" ? "low" : "medium",
      char_count: 800, word_count: 160, mixed_variance: false, model_id: "test",
      explanation: "", basis: "", reading: "", review_risk: "unclear",
      review_label: "", review: "", disclaimer: "",
      paragraphs: lang === "en" ? [{ ...paragraph, char_count: 800 }] : [paragraph, { ...paragraph, index: 1 }],
      verdict_adjustment: { code: lang === "en" ? "en_sentence_median_guard" : "zh_medium_high_guard",
        observed: lang === "en" ? .1 : .92, threshold: lang === "en" ? .3 : .925,
        original_verdict: "high", verdict: "uncertain", note: "按保守复核规则降为不确定。" },
    };
    const props = { processEvidence: { kind: "none" } as const, copied: false, onCopy: vi.fn(), onSaveVersion: vi.fn(),
      onRecheck: vi.fn(), onScan: vi.fn(), recheckingIndex: null, scanProgress: null };
    const { container, rerender } = render(<ResultCard {...props} data={data} />);
    const retested = replaceParagraph(data, 0, { ...data, paragraphs: [data.paragraphs[0]] });
    for (const current of [data, retested]) {
      rerender(<ResultCard {...props} data={current} />);
      expect(container.querySelector(".result-score strong")).toHaveTextContent("不确定");
      expect(container.querySelector(".result-raw-score")).toHaveTextContent("92.0%");
      expect(container.querySelector(".result-lead")).toHaveTextContent(current.verdict_adjustment!.note);
      expect(container.querySelector(".verdict-reasons")).toHaveTextContent(current.verdict_adjustment!.note);
      expect(container.querySelector(".result-lead")).not.toHaveTextContent("分数还不足以给出明确结论");
      expect(container.querySelector(".verdict-reasons")).not.toHaveTextContent("但只有");
      expect(container.querySelector(".verdict-reasons")).not.toHaveTextContent("原始分处于中间档");
    }
  });
});
