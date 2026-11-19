import { describe, expect, it } from "vitest";
import { formatResult, verdictReasons } from "./copy";
import { buildReportHtml } from "./report";
import type { DetectOk } from "./types";

const data: DetectOk = {
  lang: "en", score: .95, verdict: "uncertain", confidence: "low",
  char_count: 210, word_count: 40, mixed_variance: false, model_id: "test",
  explanation: "", basis: "", reading: "", review_risk: "unclear",
  review_label: "", review: "", disclaimer: "",
  paragraphs: [{ index: 0, excerpt: "text", char_count: 210, score: .95, verdict: "high" }],
};

describe("verdictReasons", () => {
  it("explains a high raw score withheld for short text", () => {
    const result = verdictReasons(data);
    expect(result.label).toBe("不确定");
    expect(result.reasons.join(" ")).toContain("只有 210 个已评分字符、1 个段落");
    expect(result.reasons.join(" ")).toContain("单段满 400 字符的英文或论文也可");
    expect(result.reasons.join(" ")).not.toContain("后端论文模式");
    expect(result.reasons.join(" ")).toContain("1 段中有 1 段为较高");
  });

  it("uses applied calibration and describes middle-band and mixed signals", () => {
    const result = verdictReasons({ ...data, score: .7, mixed_variance: true,
      calibration: { applied: true, low: .3, high: .8, status: "validated", evaluation_unit: "document", note: "" } });
    expect(result.reasons[0]).toContain("30.0%–80.0%");
    expect(result.reasons.join(" ")).toContain("信号不够一边倒");
    expect(result.reasons.join(" ")).toContain("各段差异大");
    expect(result.reasons.join(" ")).not.toContain("默认阈值");
  });

  it("ignores unapplied thresholds and handles empty paragraphs", () => {
    const result = verdictReasons({ ...data, score: .1, verdict: "low", paragraphs: [],
      calibration: { applied: false, low: .1, high: .2, status: "default", evaluation_unit: "document", note: "" } });
    expect(result.label).toBe("较低");
    expect(result.reasons[0]).toContain("40.0%–75.0%");
    expect(result.reasons.join(" ")).toContain("默认阈值");
    expect(result.reasons.join(" ")).not.toContain("段为较高");
  });

  it("does not claim eligible English single paragraphs are downgraded", () => {
    const result = verdictReasons({ ...data, char_count: 400, verdict: "high" });
    expect(result.label).toBe("较高");
    expect(result.reasons.join(" ")).toContain("满足当前文本充分度条件");
    expect(result.reasons.join(" ")).not.toContain("未判为较高");
  });

  it("puts the band before the raw score in copied and HTML reports", () => {
    for (const output of [formatResult(data), buildReportHtml(data)]) {
      expect(output.indexOf("全文判定：不确定")).toBeLessThan(output.indexOf("模型原始分：95.0%"));
      expect(output).toContain("只有 210 个已评分字符、1 个段落");
      expect(output).toContain("也不是判定档位");
    }
  });
});
