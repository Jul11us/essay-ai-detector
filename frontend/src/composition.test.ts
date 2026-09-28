import { describe, expect, it } from "vitest";
import { aiSpans, composition, documentUnits, spanPlace, type Unit } from "./composition";
import type { DetectOk, ParagraphHit, SentenceHit } from "./types";

function doc(paragraphs: ParagraphHit[]): DetectOk {
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
    basis: "",
    reading: "",
    review_risk: "unclear",
    review_label: "",
    review: "",
    disclaimer: "",
    paragraphs,
  };
}

// 每句 10 个非空白字符，方便算占比。
const s = (score: number | null, text = "abcdefghij"): SentenceHit => ({
  text,
  score,
  verdict: null,
  highlight: null,
});

function para(index: number, score: number, sentences?: SentenceHit[] | null): ParagraphHit {
  return { index, excerpt: `p${index}`, text: `p${index}`, score, verdict: "low", char_count: 100, sentences };
}

function unit(band: Unit["band"], i: number, weight = 10): Unit {
  const score = band === "ai" ? 0.9 : band === "human" ? 0.1 : 0.6;
  return { paraIndex: 0, sentIndex: i, text: "x", score, weight, band, borrowed: false };
}

describe("documentUnits", () => {
  it("逐句打过的段用句子，没打过的段整段算一个", () => {
    const units = documentUnits(doc([para(0, 0.2, [s(0.9), s(0.1)]), para(1, 0.8)]));
    expect(units.map((u) => [u.paraIndex, u.sentIndex, u.band])).toEqual([
      [0, 0, "ai"],
      [0, 1, "human"],
      [1, null, "ai"],
    ]);
    expect(units[2].weight).toBe(100);
  });

  it("没有单句分数的句子借用段分数", () => {
    const units = documentUnits(doc([para(0, 0.8, [s(0.1), s(null)])]));
    expect(units[1]).toMatchObject({ score: 0.8, band: "ai", borrowed: true });
  });
});

describe("composition", () => {
  it("大部分像 AI", () => {
    const c = composition(doc([para(0, 0.9, [s(0.95), s(0.9), s(0.99), s(0.8), s(0.1)])]));
    expect(c.ai).toBeCloseTo(0.8);
    expect(c.verdict).toBe("ai");
    expect(c.basis).toBe("sentences");
  });

  it("混合", () => {
    const c = composition(doc([para(0, 0.5, [s(0.1), s(0.1), s(0.95), s(0.9), s(0.2)])]));
    expect(c.verdict).toBe("mixed");
    expect(c.ai).toBeCloseTo(0.4);
    expect(c.human).toBeCloseTo(0.6);
  });

  it("像人写", () => {
    const c = composition(doc([para(0, 0.1, [s(0.1), s(0.2), s(0.05), s(0.5)])]));
    expect(c.verdict).toBe("human");
    expect(c.unclear).toBeCloseTo(0.25);
  });

  it("不确定的太多就说难以判断", () => {
    const c = composition(doc([para(0, 0.5, [s(0.5), s(0.6), s(0.1), s(0.7)])]));
    expect(c.verdict).toBe("unclear");
  });

  it("逐句没打完时标成部分", () => {
    const c = composition(doc([para(0, 0.2, [s(0.1)]), para(1, 0.9)]));
    expect(c.basis).toBe("partial");
    expect(composition(doc([para(0, 0.2)])).basis).toBe("paragraphs");
  });
});

describe("aiSpans", () => {
  it("连续像 AI 的句子连成一段，隔一句不确定仍算一段", () => {
    const units = [
      unit("human", 0),
      unit("ai", 1),
      unit("ai", 2),
      unit("unclear", 3),
      unit("ai", 4),
      unit("human", 5),
    ];
    const spans = aiSpans(units, 60);
    expect(spans).toHaveLength(1);
    expect(spans[0].first.sentIndex).toBe(1);
    expect(spans[0].last.sentIndex).toBe(4);
    expect(spans[0].aiUnits).toBe(3);
    expect(spans[0].chars).toBe(40);
    expect(spanPlace(spans[0])).toBe("第 1 段第 2–5 句");
  });

  it("隔着像人写的句子，或连着两句不确定，就断开", () => {
    const units = [
      unit("ai", 0),
      unit("ai", 1),
      unit("human", 2),
      unit("ai", 3),
      unit("ai", 4),
      unit("unclear", 5),
      unit("unclear", 6),
      unit("ai", 7),
      unit("ai", 8),
    ];
    expect(aiSpans(units, 90)).toHaveLength(3);
  });

  it("零散的一句短句不单独列为区段，整段级的单元要列", () => {
    expect(aiSpans([unit("human", 0), unit("ai", 1), unit("human", 2)], 30)).toHaveLength(0);
    const whole: Unit = { ...unit("ai", 0), sentIndex: null, weight: 50 };
    const spans = aiSpans([whole], 50);
    expect(spans).toHaveLength(1);
    expect(spanPlace(spans[0])).toBe("第 1 段");
  });
});
