import { detect, isDetectErr } from "./api";
import type { Confidence, ScoreLang, Verdict } from "./types";

export type Sample = {
  id: string; file?: string; lang: ScoreLang; label: "human" | "ai" | "mixed";
  source: string; source_url?: string; license?: string;
  split: "calibration" | "test" | "descriptive"; group_id: string;
  writer_group?: string; domain?: string; dataset_revision?: string;
  generated_model?: string; mixed_method?: string; text_sha256?: string;
  training_overlap?: "unknown" | "possible" | "excluded"; training_overlap_evidence?: string;
};
export type EvaluationRecord = Sample & {
  score: number; verdict: Verdict; confidence: Confidence | "unknown";
  model_id: string; model_revision: string; char_count: number | null; word_count: number | null;
  latency_ms?: number | null; input_sha256?: string; api_pipeline?: string;
};
export type Rate = { count: number; of: number; rate: number | null; wilson_ci: [number, number] | null };
export type ProfileLanguage = {
  model_id: string; model_revision: string; status: "validated" | "candidate" | "unvalidated";
  low: number | null; high: number | null; reasons: string[];
  counts: Record<"calibration" | "test", { human: number; ai: number; mixed: number; groups: number }>;
  training_overlap: { status: string; evidence: string[] };
  applicability: { char_count: { min: number | null; max: number | null }; domains: string[]; writer_groups: string[] };
  test_metrics: { human_high_false_flag: Rate; ai_low_miss: Rate; uncertain: Rate } | null;
};
export type EvaluationBundle = {
  note: string;
  report: { schema_version: number; generated_at: string; records: EvaluationRecord[];
    evaluation_run: { expected: number; completed: number; incomplete: boolean };
    latency: { mean_ms: number | null; p95_ms: number | null }; confidence_level: number;
  };
  calibration: { languages: Partial<Record<ScoreLang, ProfileLanguage>>; [key: string]: unknown } | null;
};
export type EvaluationFilter = { lang: string; split: string; source: string; length: string; writer: string };
export const ALL_FILTERS: EvaluationFilter = { lang: "all", split: "all", source: "all", length: "all", writer: "all" };

export function parseManifest(text: string): unknown[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("样本清单为空。");
  try {
    if (trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    }
    return trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch { throw new Error("清单须是 JSON 数组或每行一个对象的 JSONL 文件。"); }
}

export function importedRecords(value: unknown): { records: unknown[]; expected?: number } {
  if (typeof value !== "object" || value === null) throw new Error("请选择评测工具生成的 JSON 报告。");
  const top = value as Record<string, unknown>;
  const report = top.report && typeof top.report === "object" ? top.report as Record<string, unknown> : top;
  if (!Array.isArray(report.records) || !report.records.length) throw new Error("报告缺少逐样本 records，无法核对或重新汇总。");
  const run = report.evaluation_run as Record<string, unknown> | undefined;
  return { records: report.records, expected: typeof run?.expected === "number" ? run.expected : undefined };
}

async function post<T>(path: string, value: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error(data?.message || "评测服务没有返回可用结果，请重启检测服务后重试。");
  return data as T;
}
export async function validateManifest(samples: unknown[]): Promise<Sample[]> {
  return (await post<{ samples: Sample[] }>("/api/evaluation/manifest", { samples })).samples;
}
export function analyzeRecords(records: unknown[], expected?: number): Promise<EvaluationBundle> {
  return post("/api/evaluation/analyze", { records, expected_sample_count: expected });
}

export function matchSampleFiles(samples: Sample[], files: File[]): File[] {
  const normalize = (path: string) => path.replace(/\\/g, "/");
  return samples.map((sample) => {
    if (!sample.file) throw new Error(`样本 ${sample.id} 缺少 file 文件名。`);
    const wanted = normalize(sample.file);
    const exact = files.filter((file) => normalize(file.webkitRelativePath || file.name) === wanted);
    const candidates = exact.length ? exact : files.filter((file) => file.name === wanted.split("/").at(-1));
    if (candidates.length !== 1) throw new Error(`样本 ${sample.id} 的文件未找到或重名：${sample.file}。请选择全部样本文件，重名文件须分开评测。`);
    return candidates[0];
  });
}

export async function scoreSample(sample: Sample, file: File, signal: AbortSignal): Promise<EvaluationRecord> {
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sample.text_sha256 && fingerprint !== sample.text_sha256) throw new Error("文件校验值与清单不一致，请选择原始样本。");
  if (signal.aborted) throw new DOMException("cancelled", "AbortError");
  const started = performance.now();
  const result = await detect({ lang: sample.lang, text: "", file }, signal);
  if (isDetectErr(result)) throw new Error(result.message);
  if (result.lang === "bi") throw new Error("评测须按中文、英文分别计算。");
  return { ...sample, score: result.score, verdict: result.verdict, confidence: result.confidence,
    model_id: result.model_id, model_revision: result.model_revision || "unknown", char_count: result.char_count,
    word_count: result.word_count, latency_ms: performance.now() - started, input_sha256: fingerprint, api_pipeline: "/api/detect" };
}

export function lengthBucket(record: EvaluationRecord): string {
  return record.char_count === null ? "unknown" : record.char_count < 400 ? "under_400_chars" : record.char_count < 1500 ? "400_to_1499_chars" : "1500_plus_chars";
}
export function filterRecords(records: EvaluationRecord[], filter: EvaluationFilter): EvaluationRecord[] {
  return records.filter((r) => (filter.lang === "all" || r.lang === filter.lang) && (filter.split === "all" || r.split === filter.split)
    && (filter.source === "all" || r.source === filter.source) && (filter.length === "all" || lengthBucket(r) === filter.length)
    && (filter.writer === "all" || (r.writer_group || "unspecified") === filter.writer));
}

/** Wilson 95% interval; these are sample proportions, not population guarantees. */
export function rate(count: number, denominator: number): Rate {
  if (!Number.isInteger(count) || !Number.isInteger(denominator) || count < 0 || denominator < count) throw new Error("Invalid counts");
  if (!denominator) return { count, of: 0, rate: null, wilson_ci: null };
  const z = 1.959963984540054, z2 = z * z, p = count / denominator, divisor = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / divisor;
  const margin = z * Math.sqrt(p * (1 - p) / denominator + z2 / (4 * denominator ** 2)) / divisor;
  return { count, of: denominator, rate: p, wilson_ci: [count === 0 ? 0 : Math.max(0, center - margin), count === denominator ? 1 : Math.min(1, center + margin)] };
}
export function recordMetrics(records: EvaluationRecord[]) {
  const human = records.filter((r) => r.label === "human"), ai = records.filter((r) => r.label === "ai");
  const measure = (rows: EvaluationRecord[], verdict: string) => rate(rows.filter((r) => r.verdict === verdict).length, rows.length);
  return { humanFalseFlag: measure(human, "high"), aiMiss: measure(ai, "low"),
    humanUncertain: measure(human, "uncertain"), aiUncertain: measure(ai, "uncertain"),
    insufficient: rate(records.filter((r) => r.confidence === "low").length, records.length),
    groups: new Set(records.map((r) => r.group_id)).size };
}

export function reasonLabel(reason: string): string {
  if (reason.includes("training overlap")) return "未提供排除模型训练数据重叠的证据";
  if (reason.includes("independent test Wilson")) return "独立测试误报或漏报的置信区间上界超出要求";
  if (reason.includes("no calibration threshold")) return "校准集无法拟合符合约束的阈值";
  if (reason.includes("fewer than")) return "独立样本或问题组不足（每类、每集合至少 30）";
  if (reason.includes("missing human") || reason.includes("missing ai")) return "校准集或测试集缺少人写／AI 类别";
  if (reason.includes("statistically correlated")) return "同一问题组的同类版本重复，不能当作独立样本";
  if (reason.includes("evaluation incomplete")) return "本轮有失败或取消样本，评测尚未完整完成";
  if (reason.includes("fingerprint") || reason.includes("model id/revision")) return "实际模型版本未核验";
  if (reason.includes("API confidence")) return "缺少实际文本长度或充分度信息";
  if (reason.includes("pipeline provenance")) return "未确认预测来自完整检测流程";
  if (reason.includes("source URL/license")) return "缺少来源链接或许可信息";
  if (reason.includes("input fingerprints")) return "缺少样本文件校验值，无法检查重复与泄漏";
  return reason;
}
