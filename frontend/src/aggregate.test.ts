import { describe, expect, it } from "vitest";
import {
  carrySentences,
  paragraphsToScan,
  reaggregate,
  replaceParagraph,
  sameScores,
  topSuspects,
} from "./aggregate";
import type { DetectOk } from "./types";

function doc(paragraphs: DetectOk["paragraphs"]): DetectOk {
  return {
    score: 0,
    verdict: "uncertain",
    confidence: "medium",
    mixed_variance: false,
    char_count: 0,
    word_count: 0,
    model_id: "demo",
    lang: "en",
    explanation: "",
    basis: "依据",
    reading: "",
    review_risk: "unclear",
    review_label: "",
    review: "",
    disclaimer: "免责",
    paragraphs,
  };
}

describe("replaceParagraph", () => {
  it.each([0.0001, 0.2])("preserves document paraphrase review after an unchanged paragraph retest (%s)", (score) => {
    const current = Object.assign(doc([
      { index: 0, text: "Body.", excerpt: "Body.", score, verdict: "low", char_count: 450 },
    ]), {
      paraphrase_review: true,
      second_opinion_score: 0.9,
      reading: "英文第二模型提示需人工复核。",
      review_label: "作业审查：英文第二模型建议复核",
      review: "这不是 AI 生成证据。",
    });
    const next = replaceParagraph(current, 0, doc([current.paragraphs[0]]));
    expect(next.verdict).toBe("uncertain");
    expect(next.score).toBe(score);
    expect(next).toMatchObject({ paraphrase_review: true, second_opinion_score: 0.9 });
    expect(next.reading).toBe(current.reading);
    expect(next.review_risk).toBe(current.review_risk);
    expect(next.review_label).toBe(current.review_label);
    expect(next.review).toBe(current.review);
    expect(next.explanation).toContain(current.reading);
    expect(next.explanation).toContain(current.review_label);
    expect(next.explanation).toContain(current.review);
  });

  it.each([
    [undefined, 0.2, "low"],
    [false, 0.2, "low"],
    [true, 0.5, "uncertain"],
    [true, 0.9, "high"],
  ] as const)("leaves recomputed verdicts unchanged for review=%s, score=%s", (flag, score, verdict) => {
    const current = Object.assign(doc([
      { index: 0, text: "Body.", excerpt: "Body.", score, verdict, char_count: 450 },
    ]), { paraphrase_review: flag, reading: "Second model note", review_label: "Second model label" });
    const next = replaceParagraph(current, 0, doc([current.paragraphs[0]]));
    expect(next.verdict).toBe(verdict);
    expect(next.reading).not.toBe(current.reading);
    expect(next.review_label).not.toBe(current.review_label);
  });

  it("distinguishes original file scope from edited and rescored text", () => {
    const current = doc([{ index: 0, text: "Original body.", excerpt: "Original body.", score: .2, verdict: "low", char_count: 400 }]);
    current.detection_scope = { source_name: "paper.txt", source_sha256: "a".repeat(64), total_blocks: 6, selected_blocks: 1, total_chars: 1000, selected_chars: 400, excluded: [], note: "分数仅对应所选文字。" };
    const changed = doc([{ index: 0, text: "Edited body.", excerpt: "Edited body.", score: .1, verdict: "low", char_count: 500 }]);
    const next = replaceParagraph(current, 0, changed);
    expect(next.detection_scope?.selected_chars).toBe(400);
    expect(next.detection_scope?.note).toContain("正文已在复核中修改");
    expect(next.char_count).toBe(500);
    expect(replaceParagraph(next, 0, changed).detection_scope?.note).toBe(next.detection_scope?.note);
  });
  it("keeps verified document thresholds during paragraph edits without changing paragraph bands", () => {
    const current = doc([
      { index: 0, excerpt: "a", score: 0.65, verdict: "uncertain", char_count: 400 },
      { index: 1, excerpt: "b", score: 0.65, verdict: "uncertain", char_count: 400 },
    ]);
    current.calibration = { status: "validated", applied: true, low: 0.2, high: 0.6,
      evaluation_unit: "document", note: "测试范围内", applicability: { char_count: { min: 500, max: 1600 } } };
    const next = replaceParagraph(current, 1, doc([current.paragraphs[1]]));
    expect(next.verdict).toBe("high");
    expect(next.paragraphs.every((p) => p.verdict === "uncertain")).toBe(true);
    expect(next.calibration?.applied).toBe(true);
  });

  it("restores default thresholds and explanation when edits leave the evaluated length range", () => {
    const current = doc([
      { index: 0, excerpt: "a", score: 0.65, verdict: "uncertain", char_count: 400 },
      { index: 1, excerpt: "b", score: 0.65, verdict: "uncertain", char_count: 400 },
    ]);
    current.basis = "模型依据。当前整篇档位：低于 20% 为较低。作文适用性仍需真实作文语料验证。";
    current.calibration = { status: "validated", applied: true, low: 0.2, high: 0.6,
      evaluation_unit: "document", note: "测试范围内", applicability: { char_count: { min: 700, max: 1600 } } };
    const next = replaceParagraph(current, 1, doc([
      { index: 0, excerpt: "short", score: 0.65, verdict: "uncertain", char_count: 100 },
    ]));
    expect(next.verdict).toBe("uncertain");
    expect(next.calibration?.applied).toBe(false);
    expect(next.basis).toContain("75.0%");
    expect(next.explanation).not.toContain("20%");
  });

  it("never uses candidate document thresholds in local reaggregation", () => {
    const current = doc([
      { index: 0, excerpt: "a", score: 0.65, verdict: "uncertain", char_count: 400 },
      { index: 1, excerpt: "b", score: 0.65, verdict: "uncertain", char_count: 400 },
    ]);
    current.calibration = { status: "candidate", applied: false, low: 0.2, high: 0.6,
      evaluation_unit: "document", note: "尚未通过测试" };
    expect(replaceParagraph(current, 1, doc([current.paragraphs[1]])).verdict).toBe("uncertain");
  });

  it("reweights the document from the edited paragraph", () => {
    const current = doc([
      { index: 0, excerpt: "a", text: "a", score: 0.2, verdict: "low", char_count: 100 },
      { index: 1, excerpt: "b", text: "b", score: 0.8, verdict: "high", char_count: 300 },
    ]);
    const piece = doc([
      { index: 0, excerpt: "b2", text: "b2", score: 0.1, verdict: "low", char_count: 300 },
    ]);
    const next = replaceParagraph(current, 1, piece);
    expect(next.score).toBe(0.125);
    expect(next.verdict).toBe("low");
    expect(next.paragraphs[1].score).toBe(0.1);
    expect(next.paragraphs[1].sentences).toBeNull();
    expect(next.paragraphs[0].text).toBe("a");
    expect(next.reading).toContain("较低");
  });

  it("treats identical scores as unchanged", () => {
    const current = doc([
      { index: 0, excerpt: "a", score: 0.2, verdict: "low", char_count: 200 },
    ]);
    const stats = reaggregate(current.paragraphs);
    expect(sameScores({ ...current, ...stats }, { ...current, ...stats })).toBe(true);
  });
});

describe("topSuspects", () => {
  const sent = (text: string, score: number | null) => ({
    text,
    score,
    verdict: null,
    highlight: score == null ? null : score >= 0.75 ? ("high" as const) : score >= 0.6 ? ("mid" as const) : null,
  });

  it("ranks only high-band sentences across paragraphs and caps the count", () => {
    const current = doc([
      {
        index: 0, excerpt: "", text: "", score: 0.9, verdict: "high", char_count: 300,
        sentences: [sent("a", 0.8), sent("b", 0.65), sent("c", 0.97)],
      },
      {
        index: 1, excerpt: "", text: "", score: 0.9, verdict: "high", char_count: 300,
        sentences: [sent("d", 0.9), sent("e", null), sent("f", 0.76)],
      },
      { index: 2, excerpt: "", text: "", score: 0.1, verdict: "low", char_count: 300 },
    ]);
    const top = topSuspects(current, 3);
    expect(top.map((s) => s.text)).toEqual(["c", "d", "a"]);
    expect(top[0]).toMatchObject({ paraIndex: 0, sentIndex: 2 });
    expect(topSuspects(current).map((s) => s.text)).toEqual(["c", "d", "a", "f"]);
  });

  it("returns nothing when no sentence reaches the high band", () => {
    const current = doc([
      {
        index: 0, excerpt: "", text: "", score: 0.8, verdict: "high", char_count: 300,
        sentences: [sent("a", 0.7)],
      },
    ]);
    expect(topSuspects(current)).toEqual([]);
  });
});


describe("整篇逐句打分", () => {
  const hit = { text: "x", score: 0.2, verdict: "low" as const, highlight: null };

  it("低分段也要逐句打分，已打过的和没有全文的跳过", () => {
    const current = doc([
      { index: 0, excerpt: "a", text: "a", score: 0.1, verdict: "low", char_count: 300 },
      { index: 1, excerpt: "b", text: "b", score: 0.9, verdict: "high", char_count: 300, sentences: [hit] },
      { index: 2, excerpt: "c", score: 0.5, verdict: "uncertain", char_count: 300 },
      { index: 3, excerpt: "d", text: "d", score: 0.3, verdict: "low", char_count: 30 },
    ]);
    expect(paragraphsToScan(current).map((p) => p.index)).toEqual([0, 3]);
  });

  it("重测后的新文档保留后台刚打好的其它段", () => {
    const live = doc([
      { index: 0, excerpt: "a", text: "a", score: 0.1, verdict: "low", char_count: 300, sentences: [hit] },
      { index: 1, excerpt: "b", text: "b", score: 0.9, verdict: "high", char_count: 300 },
    ]);
    const next = doc([
      { index: 0, excerpt: "a", text: "a", score: 0.1, verdict: "low", char_count: 300 },
      { index: 1, excerpt: "b2", text: "b2", score: 0.2, verdict: "low", char_count: 300, sentences: null },
    ]);
    const merged = carrySentences(live, next);
    expect(merged.paragraphs[0].sentences).toEqual([hit]);
    expect(merged.paragraphs[1].sentences).toBeNull();
  });
});

describe("English single-paragraph coverage", () => {
  it("lets one long English paragraph reach high while confidence stays low", () => {
    expect(reaggregate([{ score: 0.8, char_count: 400 }], undefined, "en")).toMatchObject({ verdict: "high", confidence: "low" });
    expect(reaggregate([{ score: 0.8, char_count: 399 }], undefined, "en").verdict).toBe("uncertain");
    expect(reaggregate([{ score: 0.8, char_count: 400 }], undefined, "zh").verdict).toBe("uncertain");
    expect(reaggregate([{ score: 0.8, char_count: 400 }]).verdict).toBe("uncertain");
  });

  it("re-tested single English paragraph keeps the high verdict and a review caveat", () => {
    const current = doc([{ index: 0, text: "Body.", excerpt: "Body.", score: .2, verdict: "low", char_count: 450 }]);
    const piece = doc([{ index: 0, text: "Edited.", excerpt: "Edited.", score: .9, verdict: "high", char_count: 450 }]);
    const next = replaceParagraph(current, 0, piece);
    expect(next.verdict).toBe("high");
    expect(next.confidence).toBe("low");
    expect(next.review_label).toContain("单段仍需人工复核");
  });
});
