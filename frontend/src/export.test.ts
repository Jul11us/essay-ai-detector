import { describe, expect, it } from "vitest";
import {
  buildBilingualCsv,
  buildResultCsv,
  buildResultJson,
  csvCell,
  toCsv,
} from "./export";
import type { BilingualOk, DetectOk } from "./types";

const DOC: DetectOk = {
  score: 0.5,
  verdict: "uncertain",
  confidence: "medium",
  mixed_variance: false,
  char_count: 400,
  word_count: 70,
  model_id: "demo",
  lang: "en",
  explanation: "",
  basis: "",
  reading: "",
  review_risk: "unclear",
  review_label: "",
  review: "",
  disclaimer: "",
  paragraphs: [
    {
      index: 0,
      excerpt: "First, second.",
      text: "First, second.",
      score: 0.8,
      verdict: "high",
      char_count: 200,
      sentences: [
        { text: "First, second.", score: 0.91234, verdict: "high", highlight: "high" },
        { text: "Short.", score: null, verdict: null, highlight: null },
      ],
    },
    { index: 1, excerpt: "Plain paragraph", text: "Plain paragraph", score: 0.1, verdict: "low", char_count: 200 },
  ],
};

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
  });
  it("leaves plain text and numbers alone, blanks null", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(0.25)).toBe("0.25");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("defuses spreadsheet formulas in text but not negative numbers", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-- dashed aside")).toBe("'-- dashed aside");
    expect(csvCell("@mention")).toBe("'@mention");
    expect(csvCell(-1)).toBe("-1");
  });
});

describe("buildResultCsv", () => {
  it("writes one row per sentence, and one per paragraph when there are no sentence scores", () => {
    const lines = buildResultCsv(DOC).trimEnd().split("\r\n");
    expect(lines[0]).toBe("language,paragraph,sentence,score,paragraph_score,verdict,highlight,text");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('en,1,1,0.9123,0.8,high,high,"First, second."');
    expect(lines[2]).toBe("en,1,2,,0.8,,,Short.");
    expect(lines[3]).toBe("en,2,,0.1,0.1,low,,Plain paragraph");
  });
});

describe("buildBilingualCsv", () => {
  it("combines both sections and skips one that failed", () => {
    const data: BilingualOk = {
      lang: "bi",
      note: "",
      disclaimer: "",
      en: DOC,
      zh: { error: "section_too_short", message: "太短" },
    };
    const lines = buildBilingualCsv(data).trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines.every((l, i) => i === 0 || l.startsWith("en,"))).toBe(true);
  });
});

describe("buildResultJson", () => {
  it("wraps the result with a schema version and export time", () => {
    const parsed = JSON.parse(buildResultJson(DOC, "2026-01-01T00:00:00.000Z"));
    expect(parsed.schema).toBe(1);
    expect(parsed.exported_at).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.result.paragraphs).toHaveLength(2);
  });
});

describe("toCsv", () => {
  it("ends every row with CRLF", () => {
    expect(toCsv([["a", "b"], [1, 2]])).toBe("a,b\r\n1,2\r\n");
  });
});
