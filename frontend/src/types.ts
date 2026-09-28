export type Lang = "zh" | "en" | "bi";
export type ScoreLang = "zh" | "en";
export type Verdict = "low" | "uncertain" | "high";
export type Confidence = "low" | "medium" | "high";

export type SentenceHit = {
  text: string;
  score: number | null;
  verdict: Verdict | null;
  highlight: "high" | "mid" | null;
  observations?: MarkerHit[];
};

export type MarkerHit = { phrase: string; count: number };

export type Rhythm = {
  lengths: number[];
  mean: number;
  cv: number;
  label: string;
  note: string;
  truncated: boolean;
};

export type ParagraphHit = {
  index: number;
  excerpt: string;
  /** 这一评分单元的全文。单段重测和逐句定位都用它，摘录只留给复制结果。 */
  text?: string;
  score: number;
  verdict: Verdict;
  /** 去空白后的字符数，也就是该段在全文里的权重。 */
  char_count: number;
  /** undefined：排队中或正在逐句打分。null：被跳过，等学生自己点。[]：失败。 */
  sentences?: SentenceHit[] | null;
  sentenceNote?: string;
};

export type DetectOk = {
  score: number;
  verdict: Verdict;
  confidence: Confidence;
  mixed_variance: boolean;
  char_count: number;
  word_count: number;
  model_id: string;
  lang: ScoreLang;
  explanation: string;
  basis: string;
  reading: string;
  review_risk: "likely_ok" | "unclear" | "likely_flag";
  review_label: string;
  review: string;
  disclaimer: string;
  markers?: MarkerHit[];
  rhythm?: Rhythm;
  paragraphs: ParagraphHit[];
  ignored?: { text: string; reason: string }[];
};

export type SectionErr = { error: string; message: string };

export type BilingualOk = {
  lang: "bi";
  note: string;
  disclaimer: string;
  en: DetectOk | SectionErr | null;
  zh: DetectOk | SectionErr | null;
};

export function isBilingual(x: { lang: string }): x is BilingualOk {
  return x.lang === "bi";
}

export function isSectionErr(x: DetectOk | SectionErr): x is SectionErr {
  return "error" in x;
}

export type DetectErr = { error: string; message: string };

export type Status = {
  phase: "downloading" | "ready" | "error";
  detail: string;
  models: { zh: boolean; en: boolean };
  /**
   * 加载线程是否还在跑。false 表示 `models` 已经是最终结果（就绪或失败），
   * 前端据此停止轮询——光看 `phase` 分不清中文是「还在下」还是「失败了」。
   */
  loading: boolean;
  /** 实际推理后端。没导出 ONNX 时两边都是 pytorch。 */
  runtime?: { zh: string; en: string };
  /** 实际使用的分类头，以及 softmax 头里 AI 类的下标（sigmoid 头为 null）。 */
  heads?: {
    zh: { kind: "softmax" | "sigmoid" | null; ai_index: number | null };
    en: { kind: "softmax" | "sigmoid" | null; ai_index: number | null };
  };
  /** 中文分类头的方向自检实测值；方向反了中文会直接不可用，这里不会出现。 */
  label_check?: Record<string, { ai_style: number; human_style: number }>;
};
