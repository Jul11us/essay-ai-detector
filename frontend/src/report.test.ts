import { describe, expect, it } from "vitest";
import { buildReportHtml } from "./report";
import type { DetectOk } from "./types";

const DATA: DetectOk = {
  score: 0.68,
  verdict: "uncertain",
  confidence: "medium",
  mixed_variance: false,
  char_count: 400,
  word_count: 80,
  model_id: "demo",
  lang: "zh",
  explanation: "",
  basis: "依据",
  reading: "阅读",
  review_risk: "unclear",
  review_label: "作业审查",
  review: "不是过关证明",
  disclaimer: "不能作为学术不端认定依据。",
  markers: [{ phrase: "综上所述", count: 2 }],
  rhythm: {
    lengths: [10, 40, 12],
    mean: 20,
    cv: 0.6,
    label: "起伏明显",
    note: "长短交替",
    truncated: false,
  },
  ignored: [{ text: "<private title>", reason: "标题或副标题" }],
  paragraphs: [
    {
      index: 0,
      excerpt: "<script>alert(1)</script>",
      text: "<script>alert(1)</script>",
      score: 0.68,
      verdict: "uncertain",
      char_count: 400,
    },
  ],
};

describe("buildReportHtml", () => {
  it("escapes the essay and keeps the disclaimer", () => {
    const html = buildReportHtml(DATA, "2026-09-27");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("不能作为学术不端认定依据");
    expect(html).toContain("综上所述");
    expect(html).toContain("不是学校");
    expect(html).toContain("2026-09-27");
    expect(html).toContain("&lt;private title&gt;");
    expect(html).not.toContain("作业审查");
  });
});
