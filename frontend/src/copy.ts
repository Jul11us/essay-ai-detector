import { composition, spanPlace } from "./composition";
import type { Confidence, DetectOk, Lang, Verdict } from "./types";

/**
 * 低于这个字数的段单独打分不稳定：标题、题干、残句只有几个 token，
 * 实测一篇人类作文里 29 字符（4 词）的题干能拿到 16.7%，而同文正文段落接近 0%。
 * 它权重很小，但和正文段并排显示会让人误以为「这段有问题」，所以默认折叠。
 */
export const SHORT_PARAGRAPH_CHARS = 80;

export function isShortParagraph(p: { char_count: number }): boolean {
  return p.char_count < SHORT_PARAGRAPH_CHARS;
}

export function canSubmit(
  lang: Lang | null,
  text: string,
  file: File | null,
  extra?: { en?: string; zh?: string },
): boolean {
  if (!lang) return false;
  if (file) return true;
  if (lang === "bi") {
    return Boolean(text.trim() || extra?.en?.trim() || extra?.zh?.trim());
  }
  return text.trim().length > 0;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  low: "较低",
  uncertain: "不确定",
  high: "较高",
};

export const CONF_LABEL: Record<Confidence, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const AI_RATE_LABEL = "AI 率（模型估计）";
export const AI_RATE_NOTE = "基于模型原始分数，未经作文样本校准；不代表 AI 所写字数占比。";

export function formatPercent(score: number): string {
  const p = score * 100;
  if (p < 0.05) return "<0.1";
  return p.toFixed(1);
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

function compositionLine(r: DetectOk): string {
  const c = composition(r);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const spans = c.spans.length ? `；连续较高分：${c.spans.map(spanPlace).join("、")}` : "";
  return `全文分布：${c.label}（按字数，较高分 ${pct(c.ai)}，不确定 ${pct(c.unclear)}，较低分 ${pct(c.human)}${spans}）`;
}

export function formatResult(r: DetectOk): string {
  const lang = r.lang === "zh" ? "中文" : "英文";
  const lines = [
    `语言：${lang}`,
    `模型：${r.model_id}`,
    `${AI_RATE_LABEL}：${formatPercent(r.score)}%（${VERDICT_LABEL[r.verdict]}；未经作文样本校准）`,
    AI_RATE_NOTE,
    `文本充分度：${CONF_LABEL[r.confidence]}（只由文本长度和段落分数计算）`,
    compositionLine(r),
    "判定依据：",
    r.basis || r.explanation,
    "这个数字表示什么：",
    r.reading || "",
    r.disclaimer,
  ];
  if (r.mixed_variance) {
    lines.push("各段差异大，不宜只看一个总分。");
  }
  if (r.rhythm) {
    lines.push(`句长节奏：${r.rhythm.label}。${r.rhythm.note}`);
  }
  if (r.markers && r.markers.length) {
    lines.push(
      "特征词：" + r.markers.map((m) => `${m.phrase}×${m.count}`).join("，"),
    );
  }
  if (r.ignored?.length) {
    lines.push(`未参与评分：${r.ignored.map((item) => item.reason + "：" + item.text).join("；")}`);
  }
  for (const p of r.paragraphs) {
    const note = isShortParagraph(p) ? "（过短，仅供参考）" : "";
    lines.push(
      `第${p.index + 1}段 ${formatPercent(p.score)}% ${VERDICT_LABEL[p.verdict]}${note}：${p.excerpt}`,
    );
  }
  return lines.join("\n");
}
