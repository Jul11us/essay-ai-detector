import type { DetectOk } from "./types";

/**
 * 全文构成：按字数算，多少像 AI、多少不确定、多少像人写，再据此给出
 * 「人写 / 混合 / AI / 难以判断」的结论，并找出连续像 AI 的区段。
 *
 * 不给「人写 x% / AI y%」式的类别概率：模型没有做过校准，那样的数字看着精确，其实没有依据。
 * 字数占比是能直接对回原文的量。
 */

export type Band = "ai" | "unclear" | "human";

// 与后端 paragraph_verdict 的档位一致：<0.40 低，≥0.75 高。
export const AI_AT = 0.75;
export const HUMAN_BELOW = 0.4;

// 结论门槛（按字数占比）。
export const AI_DOC_SHARE = 0.8;
export const MIXED_MIN_SHARE = 0.15;
export const HUMAN_DOC_SHARE = 0.5;

// 连续像 AI 的区段至少要这么长才单独列出；一两句零散的高分句已经在「嫌疑最重的句子」里。
const SPAN_MIN_UNITS = 2;
const SPAN_MIN_CHARS = 80;

export function band(score: number): Band {
  if (score >= AI_AT) return "ai";
  if (score < HUMAN_BELOW) return "human";
  return "unclear";
}

function weightOf(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export type Unit = {
  paraIndex: number;
  /** null：这一段还没逐句打分，整段作为一个单元，用段分数。 */
  sentIndex: number | null;
  text: string;
  score: number;
  weight: number;
  band: Band;
  /** 句子本身没有单句分数（太短或超出单段上限），借用了所在段的分数。 */
  borrowed: boolean;
};

/** 按原文顺序展开成单元：逐句打过的段用句子，没打过的段整段算一个。 */
export function documentUnits(doc: DetectOk): Unit[] {
  const units: Unit[] = [];
  for (const para of doc.paragraphs) {
    const sentences = para.sentences ?? [];
    const scored = sentences.some((s) => s.score != null);
    if (!scored) {
      units.push({
        paraIndex: para.index,
        sentIndex: null,
        text: para.text || para.excerpt,
        score: para.score,
        weight: para.char_count,
        band: band(para.score),
        borrowed: false,
      });
      continue;
    }
    sentences.forEach((s, sentIndex) => {
      const weight = weightOf(s.text);
      if (!weight) return;
      const score = s.score ?? para.score;
      units.push({
        paraIndex: para.index,
        sentIndex,
        text: s.text,
        score,
        weight,
        band: band(score),
        borrowed: s.score == null,
      });
    });
  }
  return units;
}

export type Span = {
  first: Unit;
  last: Unit;
  /** 区段里像 AI 的单元数（中间被并进来的不确定单元不算）。 */
  aiUnits: number;
  chars: number;
  /** 占全文字数的比例。 */
  share: number;
};

/**
 * 连续像 AI 的区段。两段 AI 之间只隔一个「不确定」单元时并成一段——
 * 单句分数有噪声，一句 0.7 夹在一串 0.95 中间不该把区段切断。隔着像人写的单元就不并。
 */
export function aiSpans(units: Unit[], total: number): Span[] {
  const spans: Span[] = [];
  let cur: { start: number; end: number; ai: number; chars: number } | null = null;
  const close = () => {
    if (!cur) return;
    const first = units[cur.start];
    const last = units[cur.end];
    const wholeParagraph = first.sentIndex === null && cur.start === cur.end;
    if (cur.ai >= SPAN_MIN_UNITS || cur.chars >= SPAN_MIN_CHARS || wholeParagraph) {
      spans.push({
        first,
        last,
        aiUnits: cur.ai,
        chars: cur.chars,
        share: total ? cur.chars / total : 0,
      });
    }
    cur = null;
  };
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u.band === "ai") {
      if (cur && cur.end === i - 1) {
        cur.end = i;
        cur.ai += 1;
        cur.chars += u.weight;
      } else if (cur && cur.end === i - 2 && units[i - 1].band === "unclear") {
        cur.chars += units[i - 1].weight + u.weight;
        cur.end = i;
        cur.ai += 1;
      } else {
        close();
        cur = { start: i, end: i, ai: 1, chars: u.weight };
      }
    } else if (u.band === "human" || (cur && cur.end < i - 1)) {
      close();
    }
  }
  close();
  return spans;
}

export type Verdict3 = "human" | "mixed" | "ai" | "unclear";

export const VERDICT3_LABEL: Record<Verdict3, string> = {
  human: "以较低分为主",
  mixed: "高低分并存",
  ai: "以较高分为主",
  unclear: "难以判断",
};

export type Composition = {
  ai: number;
  unclear: number;
  human: number;
  verdict: Verdict3;
  label: string;
  detail: string;
  /** 全部逐句打完 / 只有一部分 / 还全是段级分数。 */
  basis: "sentences" | "partial" | "paragraphs";
  units: Unit[];
  spans: Span[];
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function composition(doc: DetectOk): Composition {
  const units = documentUnits(doc);
  const total = units.reduce((sum, u) => sum + u.weight, 0);
  const share = (b: Band) =>
    total ? units.filter((u) => u.band === b).reduce((sum, u) => sum + u.weight, 0) / total : 0;
  const ai = share("ai");
  const human = share("human");
  const unclear = total ? Math.max(0, 1 - ai - human) : 0;

  let verdict: Verdict3;
  if (ai >= AI_DOC_SHARE) verdict = "ai";
  else if (ai >= MIXED_MIN_SHARE) verdict = "mixed";
  else if (human >= HUMAN_DOC_SHARE) verdict = "human";
  else verdict = "unclear";

  const bySentence = units.filter((u) => u.sentIndex !== null).length;
  const byParagraph = units.length - bySentence;
  const basis = byParagraph === 0 ? "sentences" : bySentence === 0 ? "paragraphs" : "partial";

  const spans = aiSpans(units, total);
  const detail = {
    ai: `按字数，约 ${pct(ai)} 的内容落在模型较高分档。`,
    mixed: `按字数，约 ${pct(ai)} 为较高分、${pct(human)} 为较低分、${pct(unclear)} 不确定。${
      spans.length ? `较高分内容集中在 ${spans.length} 处，见下方区段。` : "较高分句子比较分散，没有连成片。"
    }`,
    human: `按字数，约 ${pct(human)} 为较低分，较高分内容不到 ${pct(MIXED_MIN_SHARE)}。`,
    unclear: `较高分内容占 ${pct(ai)}，另有 ${pct(unclear)} 落在不确定档，模型对这篇拿不准。`,
  }[verdict];

  return {
    ai,
    unclear,
    human,
    verdict,
    label: VERDICT3_LABEL[verdict],
    detail,
    basis,
    units,
    spans,
  };
}

export function unitPlace(u: Unit): string {
  return u.sentIndex === null ? `第 ${u.paraIndex + 1} 段` : `第 ${u.paraIndex + 1} 段第 ${u.sentIndex + 1} 句`;
}

export function spanPlace(s: Span): string {
  if (s.first === s.last) return unitPlace(s.first);
  if (s.first.paraIndex === s.last.paraIndex && s.first.sentIndex !== null && s.last.sentIndex !== null) {
    return `第 ${s.first.paraIndex + 1} 段第 ${s.first.sentIndex + 1}–${s.last.sentIndex + 1} 句`;
  }
  return `${unitPlace(s.first)} 至 ${unitPlace(s.last)}`;
}
