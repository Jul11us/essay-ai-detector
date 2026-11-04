import type {
  BilingualOk,
  Confidence,
  CalibrationInfo,
  DetectOk,
  ParagraphHit,
  Verdict,
} from "./types";
import { isBilingual, isSectionErr } from "./types";
import { keepReviews } from "./reviews";

const NEAR_ZERO = 0.001;

export type Outcome = DetectOk | BilingualOk;
export type Side = "single" | "en" | "zh";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function pstdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  const variance = values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function reaggregate(
  paragraphs: { score: number; char_count: number }[],
  thresholds?: { low: number; high: number },
): {
  score: number;
  verdict: Verdict;
  confidence: Confidence;
  mixed_variance: boolean;
  char_count: number;
} {
  const total = paragraphs.reduce((sum, p) => sum + p.char_count, 0);
  const raw =
    total === 0 ? 0 : paragraphs.reduce((sum, p) => sum + p.score * p.char_count, 0) / total;
  const score = round4(raw);
  const std = pstdev(paragraphs.map((p) => p.score));
  let confidence: Confidence;
  if (total < 400 || paragraphs.length < 2) confidence = "low";
  else if (total >= 1500 && std < 0.15) confidence = "high";
  else confidence = "medium";
  const mixed_variance = std >= 0.25;
  let verdict: Verdict;
  if (score < (thresholds?.low ?? 0.4)) verdict = "low";
  else if (score >= (thresholds?.high ?? 0.75) && confidence !== "low") verdict = "high";
  else verdict = "uncertain";
  return { score, verdict, confidence, mixed_variance, char_count: total };
}

function readingText(result: { score: number; verdict: Verdict }): string {
  if (result.score < NEAR_ZERO) {
    return (
      "接近 0% 只说明：在本模型看来，这篇更像它训练时见过的人类写法，原始分数小到四舍五入会显示成 0% 或 <0.1%。" +
      "这不是「证明是人写的」，也不能保证学校检测器同样给低分。" +
      "人写的作业、改过很多遍的 AI 稿、口语化课程反思，都可能接近 0%。"
    );
  }
  if (result.verdict === "low") {
    return (
      "较低只表示整体更接近人类写作分布，不是无罪证明。" +
      "请对照下面各段：若某一段明显高于全文，应单独看那一段的措辞是否过整、过空。"
    );
  }
  if (result.verdict === "high") {
    return (
      "较高表示模型认为用词和句式更像常见 AI 输出（往往更平滑、模板感更强）。" +
      "这仍可能是人写的工整学术腔，也可能是生成后再微调。不要单凭总分认定学术不端，先看高分段在说什么。"
    );
  }
  return (
    "落在不确定区间，说明信号不够一边倒：可能是人写得比较整齐，也可能是 AI 稿夹了改写。" +
    "请以各段差异为主，不要把中间分读成「一半是 AI」。"
  );
}

// 与后端 explain.review_outlook 保持一致：只描述这份分数，不预测学校检测器或老师的判断。
function reviewOutlook(result: {
  verdict: Verdict;
  confidence: Confidence;
  mixed_variance: boolean;
  paragraphs: { verdict: Verdict }[];
}): { risk: DetectOk["review_risk"]; label: string; detail: string } {
  const hot = result.paragraphs.filter((p) => p.verdict === "high").length;
  const caveat =
    "这只按本站开源模型估计，不是学校官方审查，也不能预测 Turnitin / 知网 / GPTZero 的结果。";
  if (result.confidence === "low") {
    return {
      risk: "unclear",
      label: "作业审查：材料偏短，本站分数不稳",
      detail: "文本偏短或段太少，本站分数本身就不稳，不能据此判断任何结果。" + caveat,
    };
  }
  if (result.verdict === "high" || hot >= 2) {
    return {
      risk: "likely_flag",
      label: "作业审查：高分段较多，建议对照原文复核",
      detail:
        "按本站分数，全文或至少两段更像常见 AI 写法。请对照高分段回看原文。" +
        "也可能只是人写得很整齐，分数不是生成证据。" +
        caveat,
    };
  }
  if (result.verdict === "uncertain" || hot === 1 || result.mixed_variance) {
    let extra = "";
    if (hot === 1) extra = "有一段明显高于全文，建议先看那一段。";
    else if (result.mixed_variance) extra = "各段分数差得大，有的像人写、有的更像生成。";
    return {
      risk: "unclear",
      label: "作业审查：信号不一致，请逐段查看",
      detail: "本站没有给出一边倒的结果，不能只看总分。" + extra + caveat,
    };
  }
  return {
    risk: "likely_ok",
    label: "作业审查：按本站分数，暂未见明显高分段",
    detail:
      "本站总分偏低，各段也没有明显高分。这只说明本模型没有给出高分：" +
      "不是过关证明，也不能预测学校系统或老师的判断，他们可能看内容、引用，口径也可能不同。" +
      caveat,
  };
}

function applyStats(doc: DetectOk, paragraphs: ParagraphHit[]): DetectOk {
  const total = paragraphs.reduce((sum, p) => sum + p.char_count, 0);
  let calibration: CalibrationInfo | undefined = doc.calibration;
  const extent = calibration?.applicability?.char_count;
  if (calibration?.applied && extent && (total < extent.min || total > extent.max)) {
    calibration = {
      ...calibration,
      applied: false,
      low: 0.4,
      high: 0.75,
      note: "修改后文本长度超出校准样本范围；当前使用默认展示门槛。段落和句子着色尚未校准。",
    };
  }
  const stats = reaggregate(paragraphs, calibration?.applied ? calibration : undefined);
  let basis = doc.basis;
  if (calibration && basis.includes("当前整篇档位：")) {
    const low = calibration.applied ? calibration.low : 0.4;
    const high = calibration.applied ? calibration.high : 0.75;
    basis =
      basis.split("当前整篇档位：")[0] +
      `当前整篇档位：低于 ${(low * 100).toFixed(1)}% 为较低，${(low * 100).toFixed(1)}%–${(high * 100).toFixed(1)}% 为不确定，` +
      `不低于 ${(high * 100).toFixed(1)}% 且文本充分度不是「低」才标较高。作文适用性仍需真实作文语料验证。`;
  }
  const outlook = reviewOutlook({ ...stats, paragraphs });
  const reading = readingText(stats);
  return {
    ...doc,
    ...stats,
    calibration,
    basis,
    paragraphs,
    reading,
    review_risk: outlook.risk,
    review_label: outlook.label,
    review: outlook.detail,
    explanation: [basis, reading, outlook.label, outlook.detail].filter(Boolean).join("\n"),
  };
}

/** 用单段检测的返回替换原文里的一段，并按各段字数把总分重算一遍。 */
export function replaceParagraph(doc: DetectOk, index: number, piece: DetectOk): DetectOk {
  const incoming = piece.paragraphs.map((p) => ({ ...p, sentences: null }));
  const paragraphs = [
    ...doc.paragraphs.filter((p) => p.index < index),
    ...incoming,
    ...doc.paragraphs.filter((p) => p.index > index),
  ].map((p, i) => ({ ...p, index: i }));
  const next = applyStats(doc, paragraphs);
  const prior = doc.paragraphs.find((p) => p.index === index);
  const edited =
    incoming.map((p) => p.text || p.excerpt).join("\n\n") !== (prior?.text || prior?.excerpt);
  if (edited && next.detection_scope && !next.detection_scope.note.includes("正文已在复核中修改")) {
    next.detection_scope = {
      ...next.detection_scope,
      note:
        next.detection_scope.note +
        " 正文已在复核中修改并重测；以上段落和字符数量记录原文件的选择范围，当前分数对应报告中的修改后正文。",
    };
  }
  return next;
}

export function sameScores(a: DetectOk, b: DetectOk): boolean {
  if (a.score !== b.score || a.paragraphs.length !== b.paragraphs.length) return false;
  return a.paragraphs.every((p, i) => p.score === b.paragraphs[i]?.score);
}

export function mapParagraph(
  cur: Outcome,
  side: Side,
  index: number,
  fn: (p: ParagraphHit) => ParagraphHit,
): Outcome {
  const touch = (doc: DetectOk): DetectOk => ({
    ...doc,
    paragraphs: doc.paragraphs.map((p) => (p.index === index ? fn(p) : p)),
  });
  if (isBilingual(cur)) {
    if (side === "single") return cur;
    const part = cur[side];
    if (!part || isSectionErr(part)) return cur;
    return { ...cur, [side]: touch(part) };
  }
  if (side !== "single") return cur;
  return touch(cur);
}

function deferDoc(doc: DetectOk): DetectOk {
  let changed = false;
  const paragraphs = doc.paragraphs.map((p) => {
    if (p.sentences === undefined) {
      changed = true;
      return { ...p, sentences: null };
    }
    return p;
  });
  return changed ? { ...doc, paragraphs } : doc;
}

/** 整篇逐句打分跑完后，仍没拿到结果的段（被跳过或中途失败）改成「等学生点」。 */
export function deferUnscanned(cur: Outcome): Outcome {
  if (isBilingual(cur)) {
    return {
      ...cur,
      en: cur.en && !isSectionErr(cur.en) ? deferDoc(cur.en) : cur.en,
      zh: cur.zh && !isSectionErr(cur.zh) ? deferDoc(cur.zh) : cur.zh,
    };
  }
  return deferDoc(cur);
}

/** 整篇逐句打分要跑的段：还没打过、且有全文的。 */
export function paragraphsToScan(doc: DetectOk): ParagraphHit[] {
  return doc.paragraphs.filter((p) => p.sentences === undefined && Boolean(p.text));
}

/**
 * 用 `from` 里已有的逐句结果补 `to`：正文相同、而 `to` 这边还没有结果的段照搬过去。
 * 单段重测用发请求时的快照算新文档，期间后台逐句打分可能已经填上了别的段。
 */
export function carrySentences(from: DetectOk, to: DetectOk): DetectOk {
  const byText = new Map(
    from.paragraphs
      .filter((p) => p.sentences != null)
      .map((p) => [p.text || p.excerpt, p] as const),
  );
  let changed = false;
  const paragraphs = to.paragraphs.map((p) => {
    const hit = byText.get(p.text || p.excerpt);
    if (!hit) return p;
    changed = true;
    if (p.sentences != null)
      return { ...p, sentences: keepReviews(hit.sentences || [], p.sentences) };
    return { ...p, sentences: hit.sentences, sentenceNote: hit.sentenceNote };
  });
  return changed ? { ...to, paragraphs } : to;
}

/** 全文里「嫌疑最重」的句子最多标这么多句，涂成红底。 */
export const TOP_SUSPECTS = 5;

export type Suspect = {
  paraIndex: number;
  /** 在该段 `sentences` 数组里的下标。 */
  sentIndex: number;
  text: string;
  score: number;
};

export function suspectKey(paraIndex: number, sentIndex: number): string {
  return `${paraIndex}:${sentIndex}`;
}

/**
 * 已逐句打分的句子里，单句分数到「较高」档（highlight=high）的按分数排前几名。
 * 只从到了高档的句子里挑，避免全文都不像时也硬凑出几句红的。
 */
export function topSuspects(doc: DetectOk, limit = TOP_SUSPECTS): Suspect[] {
  const pool: Suspect[] = [];
  for (const para of doc.paragraphs) {
    (para.sentences ?? []).forEach((s, sentIndex) => {
      if (s.highlight === "high" && s.score != null && s.text) {
        pool.push({ paraIndex: para.index, sentIndex, text: s.text, score: s.score });
      }
    });
  }
  pool.sort((a, b) => b.score - a.score || a.paraIndex - b.paraIndex || a.sentIndex - b.sentIndex);
  return pool.slice(0, limit);
}
