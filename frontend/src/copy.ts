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

export const RAW_SCORE_NOTE = "模型原始分不代表 AI 所写字数占比，也不是判定档位。";

export function verdictReasons(data: DetectOk): { label: string; reasons: string[] } {
  const low = data.calibration?.applied ? data.calibration.low : 0.4;
  const high = data.calibration?.applied ? data.calibration.high : 0.75;
  const pct = (n: number) => (n * 100).toFixed(1);
  const reasons = [`低于 ${pct(low)}% 为较低，${pct(low)}%–${pct(high)}% 为不确定，不低于 ${pct(high)}% 为较高（还需满足文本充分度条件）。`];
  if (data.score >= high && data.verdict !== "high") {
    reasons.push(`原始分已达较高门槛，但文本充分度为「${CONF_LABEL[data.confidence]}」，未判为较高。已评分 ${data.char_count} 个字符、${data.paragraphs.length} 个段落；通常需 ≥400 个已评分字符且 ≥2 段，英文单段 ≥400 字符也可判较高；后端论文模式同样允许 ≥400 字符的单段。`);
  } else if (data.score >= low && data.score < high) {
    reasons.push("原始分处于中间档，信号不够一边倒。请结合原句和上下文复核。");
  } else if (data.score < low) {
    reasons.push("原始分低于较低门槛；这不是人类写作的证明。");
  } else {
    reasons.push("原始分达到较高门槛，且满足当前文本充分度条件；这不是生成证据。");
  }
  const hot = data.paragraphs.filter((p) => p.verdict === "high").length;
  if (hot) reasons.push(`${data.paragraphs.length} 段中有 ${hot} 段为较高，请优先对照原文复核。`);
  if (data.mixed_variance) reasons.push("各段差异大，不宜只看一个总分。");
  if (!data.calibration?.applied) reasons.push("当前使用默认阈值，未应用作文样本校准。");
  return { label: VERDICT_LABEL[data.verdict], reasons };
}

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
    `全文判定：${verdictReasons(r).label}`,
    `模型原始分：${formatPercent(r.score)}%`,
    RAW_SCORE_NOTE,
    `文本充分度：${CONF_LABEL[r.confidence]}（只由文本长度和段落分数计算）`,
    compositionLine(r),
    "判定依据：",
    ...verdictReasons(r).reasons.map((reason) => `- ${reason}`),
    r.basis || r.explanation,
    "这个数字表示什么：",
    r.reading || "",
    r.disclaimer,
  ];
  if (r.mixed_variance) {
    lines.push("各段差异大，不宜只看一个总分。");
  }
  if (r.calibration) lines.push(`整篇阈值：${r.calibration.note}`);
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
