import { useEffect, useRef, useState } from "react";
import { downloadText } from "./download";
import { downloadJson } from "./export";
import {
  ALL_FILTERS,
  analyzeRecords,
  filterRecords,
  importedRecords,
  matchSampleFiles,
  parseManifest,
  reasonLabel,
  recordMetrics,
  scoreSample,
  validateManifest,
} from "./evaluation";
import type {
  EvaluationBundle,
  EvaluationFilter,
  EvaluationRecord,
  ProfileLanguage,
  Rate,
  Sample,
} from "./evaluation";
import { VERDICT_LABEL } from "./copy";
import { interruptedEvaluation, withTaskLock, type EvaluationTask, type RunRow } from "./tasks";
import type { TaskLibrary } from "./useTaskLibrary";

const LABEL = { human: "人写", ai: "AI", mixed: "混合" };
const SPLIT: Record<string, string> = {
  test: "独立测试集",
  calibration: "校准集",
  descriptive: "描述性样本",
};
const LENGTH: Record<string, string> = {
  under_400_chars: "不足 400 字符",
  "400_to_1499_chars": "400–1499 字符",
  "1500_plus_chars": "至少 1500 字符",
  unknown: "长度未知",
};
const percent = (value: number | null) =>
  value === null ? "无样本" : `${(value * 100).toFixed(1)}%`;
const fmtRate = (value: Rate) => `${value.count} / ${value.of} · ${percent(value.rate)}`;
const interval = (value: Rate) =>
  value.wilson_ci
    ? `${percent(value.wilson_ci[0])}–${percent(value.wilson_ci[1])}`
    : "无样本，无法计算";

function RateRow({ title, detail, value }: { title: string; detail: string; value: Rate }) {
  return (
    <tr>
      <th scope="row">
        {title}
        <small>{detail}</small>
      </th>
      <td>{fmtRate(value)}</td>
      <td>
        <span>{interval(value)}</span>
        {value.wilson_ci && (
          <div className="ci-track" aria-hidden="true">
            <span
              style={{
                left: `${value.wilson_ci[0] * 100}%`,
                width: `${(value.wilson_ci[1] - value.wilson_ci[0]) * 100}%`,
              }}
            />
            <i style={{ left: `${(value.rate || 0) * 100}%` }} />
          </div>
        )}
      </td>
    </tr>
  );
}

function LabelDistribution({
  records,
  label,
}: {
  records: EvaluationRecord[];
  label: keyof typeof LABEL;
}) {
  const rows = records.filter((r) => r.label === label);
  const bands = (["low", "uncertain", "high"] as const).map((band) => ({
    band,
    n: rows.filter((r) => r.verdict === band).length,
  }));
  return (
    <div className="evaluation-distribution">
      <div>
        <strong>{LABEL[label]}</strong>
        <span>{rows.length} 份</span>
      </div>
      <div
        className="evaluation-strip"
        role="img"
        aria-label={`${LABEL[label]}：${bands.map(({ band, n }) => `${VERDICT_LABEL[band]} ${n} 份`).join("，")}`}
      >
        {bands
          .filter(({ n }) => n > 0)
          .map(({ band, n }) => (
            <span key={band} className={band} style={{ flex: n }}>
              {n}
            </span>
          ))}
        {!rows.length && <span className="no-data">无样本</span>}
      </div>
      <p>
        {bands
          .map(
            ({ band, n }) =>
              `${VERDICT_LABEL[band]} ${n}（${percent(rows.length ? n / rows.length : null)}）`,
          )
          .join(" · ")}
      </p>
    </div>
  );
}

function CalibrationCard({ lang, entry }: { lang: string; entry: ProfileLanguage }) {
  const status =
    entry.status === "validated"
      ? "本组验证通过 · 尚未启用"
      : entry.status === "candidate"
        ? "候选阈值 · 尚未启用"
        : "尚无可用候选阈值";
  return (
    <article className="calibration-card">
      <h4>
        {lang === "zh" ? "中文" : "英文"}
        <span>{status}</span>
      </h4>
      {entry.low !== null && entry.high !== null && (
        <p className="threshold-pair">
          较低边界 <strong>{percent(entry.low)}</strong> · 较高边界{" "}
          <strong>{percent(entry.high)}</strong>
        </p>
      )}
      <p>
        校准：人写 {entry.counts.calibration.human}、AI {entry.counts.calibration.ai}
        ；独立测试：人写 {entry.counts.test.human}、AI {entry.counts.test.ai}。
      </p>
      {entry.test_metrics && (
        <div className="table-scroll">
          <table className="evaluation-metrics">
            <caption>候选阈值的独立测试表现</caption>
            <thead>
              <tr>
                <th>指标</th>
                <th>样本比例</th>
                <th>95% Wilson 区间</th>
              </tr>
            </thead>
            <tbody>
              <RateRow
                title="人写误报"
                detail="被判为较高"
                value={entry.test_metrics.human_high_false_flag}
              />
              <RateRow title="AI 漏报" detail="被判为较低" value={entry.test_metrics.ai_low_miss} />
              <RateRow
                title="二元样本不确定"
                detail="仅人写与 AI"
                value={entry.test_metrics.uncertain}
              />
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">
        训练数据重叠：
        {entry.training_overlap.status === "excluded"
          ? "提供了排除证据，仍需核验"
          : entry.training_overlap.status === "possible"
            ? "可能重叠"
            : "未知，尚未排除"}
        。
      </p>
      {!!entry.reasons.length && (
        <ul className="calibration-reasons">
          {[...new Set(entry.reasons.map(reasonLabel))].map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>来源范围与模型版本</summary>
        <p>
          题材：{entry.applicability.domains.join("、") || "未记录"}；作者组别：
          {entry.applicability.writer_groups.join("、") || "未记录"}。
        </p>
        <p>
          二元样本长度：{entry.applicability.char_count.min ?? "未知"}–
          {entry.applicability.char_count.max ?? "未知"} 个非空白字符。
        </p>
        <p className="model-name">
          {entry.model_id}
          <br />
          {entry.model_revision}
        </p>
        {!!entry.training_overlap.evidence.length && (
          <p>{entry.training_overlap.evidence.join("；")}</p>
        )}
      </details>
    </article>
  );
}

function template() {
  return (
    [
      {
        id: "human-001",
        file: "human-001.txt",
        lang: "en",
        label: "human",
        source: "请替换为真实来源",
        source_url: "https://example.com/source",
        license: "请填写许可或本人授权",
        split: "descriptive",
        group_id: "question-001",
        writer_group: "unknown",
        training_overlap: "unknown",
      },
      {
        id: "ai-001",
        file: "ai-001.txt",
        lang: "en",
        label: "ai",
        source: "请替换为真实来源",
        source_url: "https://example.com/source",
        license: "请填写许可或本人授权",
        split: "descriptive",
        group_id: "question-001",
        writer_group: "unknown",
        generated_model: "请记录生成模型及版本",
        training_overlap: "unknown",
      },
    ]
      .map((sample) => JSON.stringify(sample))
      .join("\n") + "\n"
  );
}

const STATE = {
  queued: "排队中",
  running: "检测中",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};

export function EvaluationPanel({
  active,
  models,
  onBusyChange,
  library,
  restored,
  onTaskChange,
  controlRef,
}: {
  active: boolean;
  models?: { en: boolean; zh: boolean };
  onBusyChange: (busy: boolean) => void;
  library?: TaskLibrary;
  restored?: { task: EvaluationTask; files: File[]; token: number } | null;
  onTaskChange?: (id: string | null) => void;
  controlRef?: { current: { cancel: () => void } | null };
}) {
  const [bundle, setBundle] = useState<EvaluationBundle | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState<EvaluationFilter>(ALL_FILTERS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState(0);
  const control = useRef<AbortController | null>(null);
  const taskId = useRef<string | null>(null);
  const predictions = useRef<EvaluationRecord[]>([]);
  useEffect(() => () => control.current?.abort(), []);
  useEffect(() => {
    if (!restored) return;
    const { task } = restored;
    setSamples(task.samples);
    setFiles(restored.files);
    setRows(interruptedEvaluation(task.rows));
    predictions.current = task.records;
    taskId.current = task.id;
    onTaskChange?.(task.id);
    setBundle(task.bundle);
    setPage(0);
    setError("");
    setFilter({
      ...ALL_FILTERS,
      split: task.bundle?.report.records.some((r) => r.split === "test") ? "test" : "all",
    });
  }, [restored, onTaskChange]);
  const locked = loading || running;
  const modelsReady = samples.every((sample) => models?.[sample.lang]);
  const resetRun = () => {
    setRows([]);
    predictions.current = [];
    taskId.current = null;
    onTaskChange?.(null);
  };

  const adopt = (result: EvaluationBundle) => {
    setBundle(result);
    setPage(0);
    setFilter({
      ...ALL_FILTERS,
      split: result.report.records.some((r) => r.split === "test") ? "test" : "all",
    });
  };
  const readFile = async (file: File) => {
    if (file.size > 12 * 1024 * 1024) throw new Error("清单或报告超过 12 MB，请分开导入。");
    return file.text();
  };
  const importReport = async (file: File) => {
    setLoading(true);
    setError("");
    try {
      const parsed = importedRecords(JSON.parse((await readFile(file)).replace(/^\uFEFF/, "")));
      adopt(await analyzeRecords(parsed.records, parsed.expected));
      resetRun();
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? "报告不是有效 JSON 文件。"
          : err instanceof Error
            ? err.message
            : "报告导入失败。",
      );
    } finally {
      setLoading(false);
    }
  };
  const importManifest = async (file: File) => {
    setLoading(true);
    setError("");
    try {
      setSamples(await validateManifest(parseManifest(await readFile(file))));
      resetRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清单导入失败。");
    } finally {
      setLoading(false);
    }
  };
  const run = async (fresh = false) => {
    if (control.current) return;
    setError("");
    let selected: File[];
    try {
      selected = matchSampleFiles(samples, files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请检查样本文件。");
      return;
    }
    const controller = new AbortController();
    control.current = controller;
    if (controlRef) controlRef.current = { cancel: () => controller.abort() };
    const records: EvaluationRecord[] = fresh ? [] : [...predictions.current];
    predictions.current = records;
    const finished = new Set(records.map((r) => r.id));
    let state: RunRow[] = samples.map((s) => ({
      id: s.id,
      state: finished.has(s.id) ? "done" : "queued",
    }));
    let latestBundle = fresh ? null : bundle;
    if (fresh) setBundle(null);
    setPage(0);
    setRows(state);
    setRunning(true);
    onBusyChange(true);
    let acquired = false;
    const checkpoint = (taskState: EvaluationTask["state"]) => {
      const task = taskId.current ? library?.get(taskId.current) : null;
      if (task?.kind === "evaluation")
        library?.save({
          ...task,
          rows: [...state],
          records: [...records],
          bundle: latestBundle,
          state: taskState,
        });
    };
    try {
      if (library && (fresh || !taskId.current || !library.get(taskId.current))) {
        const task = await library.create(
          { kind: "evaluation", samples, rows: state, records: [...records], bundle: latestBundle },
          selected,
          `样本评测 · ${samples.length} 份`,
        );
        taskId.current = task.id;
        onTaskChange?.(task.id);
      }
      await withTaskLock(taskId.current, async () => {
        acquired = true;
        checkpoint("running");
        for (let index = 0; index < samples.length; index++) {
          if (controller.signal.aborted) break;
          if (finished.has(samples[index].id)) continue;
          state = state.map((row, i) => (i === index ? { ...row, state: "running" } : row));
          setRows(state);
          checkpoint("running");
          try {
            if (selected[index].size > 20 * 1024 * 1024) throw new Error("文件超过 20 MB 上限。");
            records.push(await scoreSample(samples[index], selected[index], controller.signal));
            state = state.map((row, i) => (i === index ? { ...row, state: "done" } : row));
          } catch (err) {
            state = state.map((row, i) =>
              i === index
                ? {
                    ...row,
                    state: controller.signal.aborted ? "cancelled" : "error",
                    message: controller.signal.aborted
                      ? undefined
                      : err instanceof Error
                        ? err.message
                        : "检测失败",
                  }
                : row,
            );
          }
          setRows(state);
          checkpoint("running");
        }
        state = state.map((row) =>
          row.state === "queued" || row.state === "running" ? { ...row, state: "cancelled" } : row,
        );
        setRows(state);
        if (records.length) {
          latestBundle = await analyzeRecords(records, samples.length);
          adopt(latestBundle);
        } else setError("本轮没有完成样本，无法汇总。请查看失败原因或重新运行。");
        checkpoint(state.every((r) => r.state === "done") ? "complete" : "paused");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "评测汇总失败。");
      if (acquired) {
        state = interruptedEvaluation(state);
        setRows(state);
        checkpoint("paused");
      }
    } finally {
      setRunning(false);
      onBusyChange(false);
      control.current = null;
      if (controlRef) controlRef.current = null;
    }
  };
  if (!active) return null;
  const records = bundle?.report.records || [];
  const selected = filterRecords(records, filter);
  const metrics = recordMetrics(selected);
  const binaryCount = metrics.humanUncertain.of + metrics.aiUncertain.of;
  const uncertainCount = metrics.humanUncertain.count + metrics.aiUncertain.count;
  const completed = rows.filter((r) => r.state === "done").length;
  const setChoice = (key: keyof EvaluationFilter, value: string) => {
    setFilter((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  };
  const options = (values: string[]) => [...new Set(values)].sort();
  const pageRows = selected.slice(page * 25, (page + 1) * 25);
  return (
    <section className="evaluation" aria-labelledby="evaluation-title">
      <header className="evaluation-heading">
        <p className="kicker">本机评测</p>
        <h2 id="evaluation-title">样本表现，逐项核对</h2>
        <p>查看误报、漏报与不确定结果。公开问答或小规模样本的表现，不能直接代表作文检测准确率。</p>
      </header>
      <div className="evaluation-imports">
        <section className="panel">
          <span className="import-index">01 / IMPORT</span>
          <h3>查看已有评测</h3>
          <p>导入含逐样本记录的 JSON 报告。指标会重新汇总，原文不会显示在面板中。</p>
          <label className="file-label">
            导入评测报告
            <input
              aria-label="导入评测报告"
              type="file"
              accept=".json,application/json"
              disabled={locked}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importReport(file);
              }}
            />
          </label>
          <p className="fine">支持本项目评测工具和面板导出的报告。标签及来源需要人工核验。</p>
        </section>
        <section className="panel">
          <span className="import-index">02 / EVALUATE</span>
          <h3>用本机模型评测样本</h3>
          <p>先导入包含语言、标签和来源的清单，再选择对应正文文件。逐篇运行，不合并中英文分数。</p>
          <div className="evaluation-file-fields">
            <label>
              样本清单（JSONL／JSON 数组）
              <input
                aria-label="导入样本清单"
                type="file"
                accept=".jsonl,.json"
                disabled={locked}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importManifest(file);
                }}
              />
            </label>
            <label>
              样本正文（可多选）
              <input
                aria-label="选择评测样本文件"
                type="file"
                multiple
                accept=".txt,.docx,.pdf"
                disabled={locked}
                onChange={(e) => {
                  const incoming = Array.from(e.target.files || []);
                  if (incoming.length > 1000) setError("每轮最多选择 1000 份样本文件。");
                  else {
                    setFiles(incoming);
                    resetRun();
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="fine">
            清单 {samples.length} 份 · 已选择文件 {files.length} 份。上限 1000 份，每份最多 20 MB。
          </p>
          {!!samples.length && !modelsReady && (
            <p role="status" className="fine">
              本轮需要的检测模型尚未就绪，可以先查看已有评测。
            </p>
          )}
          <div className="result-actions">
            <button
              type="button"
              className="text-btn"
              disabled={locked}
              onClick={() =>
                downloadText(
                  template(),
                  "evaluation-manifest-template.jsonl",
                  "application/x-ndjson",
                )
              }
            >
              下载清单模板
            </button>
            <button
              type="button"
              className="eval-primary"
              disabled={
                locked ||
                !samples.length ||
                !files.length ||
                !modelsReady ||
                (predictions.current.length === samples.length && !!bundle)
              }
              onClick={() => void run()}
            >
              {predictions.current.length
                ? predictions.current.length < samples.length
                  ? "继续未完成样本"
                  : "重新汇总评测"
                : "开始样本评测"}
            </button>
            {!!predictions.current.length && (
              <button
                type="button"
                className="text-btn"
                disabled={locked || !modelsReady}
                onClick={() => void run(true)}
              >
                重新评测全部
              </button>
            )}
            {running && (
              <button type="button" onClick={() => control.current?.abort()}>
                停止本轮评测
              </button>
            )}
          </div>
          <details>
            <summary>标签和分组怎样填写</summary>
            <p>
              标签 human、ai、mixed
              须有来源依据；模板中的占位来源需替换。自写或授权材料可以记录本人的许可，不必公开正文。
            </p>
            <p>
              同一题目或文章的人写、AI、改写和混合版本须使用同一 group_id。拟合阈值时，整组放入
              calibration 或 test，不得跨集合；只查看表现可全部使用 descriptive。
            </p>
            <p>预测报告不保存正文或本机文件路径。下载位置由浏览器设置决定。</p>
          </details>
        </section>
      </div>
      {loading && (
        <p className="evaluation-loading" role="status">
          <span className="button-spinner" aria-hidden="true" />
          正在核对并汇总评测记录…
        </p>
      )}
      {error && (
        <p role="alert" className="fail">
          {error}
        </p>
      )}
      {!!rows.length && (
        <details
          className="panel evaluation-run"
          open={running || rows.some((r) => r.state === "error" || r.state === "cancelled")}
        >
          <summary>
            本轮样本进度：完成 {completed} / {rows.length}
            {running ? " · 正在评测" : ""}
          </summary>
          {running && (
            <progress
              aria-label="样本评测进度"
              max={rows.length}
              value={rows.filter((r) => r.state !== "queued" && r.state !== "running").length}
            />
          )}
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <span>{row.id}</span>
                <strong>{STATE[row.state]}</strong>
                {row.message && <p>{row.message}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!bundle && (
        <div className="evaluation-empty">
          <span className="empty-symbol" aria-hidden="true">
            [ ↗ ]
          </span>
          <h3>从一份有来源的评测开始</h3>
          <p>
            导入现有
            report.json，或使用上方清单运行样本。没有已知标签的演示文章不用于计算误报和漏报。
          </p>
        </div>
      )}
      {bundle && (
        <>
          <div className="evaluation-toolbar">
            <p>
              已载入 {records.length} 份预测 · {options(records.map((r) => r.source)).length} 个来源
            </p>
            <div className="result-actions">
              <button
                type="button"
                className="text-btn"
                disabled={locked}
                onClick={() =>
                  downloadJson(JSON.stringify(bundle, null, 2), "evaluation-report.json")
                }
              >
                导出评测报告
              </button>
              {bundle.calibration && (
                <button
                  type="button"
                  className="text-btn"
                  disabled={locked}
                  onClick={() =>
                    downloadJson(
                      JSON.stringify(bundle.calibration, null, 2),
                      "calibration-candidate.json",
                    )
                  }
                >
                  导出候选阈值配置
                </button>
              )}
            </div>
          </div>
          <aside className="notice">
            {bundle.note}
            {bundle.report.evaluation_run.incomplete && (
              <strong>
                {" "}
                本轮计划 {bundle.report.evaluation_run.expected} 份，只完成{" "}
                {bundle.report.evaluation_run.completed}{" "}
                份；失败和取消未计入指标，候选配置不能据此启用。
              </strong>
            )}
          </aside>
          <fieldset className="evaluation-filters">
            <legend>筛选样本</legend>
            <label>
              语言
              <select
                aria-label="评测语言筛选"
                value={filter.lang}
                onChange={(e) => setChoice("lang", e.target.value)}
              >
                <option value="all">中英文全部</option>
                <option value="en">英文</option>
                <option value="zh">中文</option>
              </select>
            </label>
            <label>
              样本集合
              <select
                aria-label="评测集合筛选"
                value={filter.split}
                onChange={(e) => setChoice("split", e.target.value)}
              >
                <option value="all">全部集合</option>
                {options(records.map((r) => r.split)).map((s) => (
                  <option key={s} value={s}>
                    {SPLIT[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              来源
              <select
                aria-label="评测来源筛选"
                value={filter.source}
                onChange={(e) => setChoice("source", e.target.value)}
              >
                <option value="all">全部来源</option>
                {options(records.map((r) => r.source)).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              长度
              <select
                aria-label="评测长度筛选"
                value={filter.length}
                onChange={(e) => setChoice("length", e.target.value)}
              >
                <option value="all">全部长度</option>
                {Object.entries(LENGTH).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <label>
              作者组别
              <select
                aria-label="评测作者组筛选"
                value={filter.writer}
                onChange={(e) => setChoice("writer", e.target.value)}
              >
                <option value="all">全部作者组别</option>
                {options(records.map((r) => r.writer_group || "unspecified")).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </fieldset>
          <section className="panel evaluation-results" aria-labelledby="evaluation-results-title">
            <h3 id="evaluation-results-title">记录中的判定分布</h3>
            <p role="status">
              当前筛选 {selected.length} / {records.length} 份 · {metrics.groups} 个问题／文章组
            </p>
            <dl className="metric-overview" aria-label="当前筛选关键指标">
              <div>
                <dt>人写误报</dt>
                <dd>
                  {percent(metrics.humanFalseFlag.rate)}
                  <small>
                    {metrics.humanFalseFlag.count} / {metrics.humanFalseFlag.of} 份人写样本
                  </small>
                </dd>
              </div>
              <div>
                <dt>AI 漏报</dt>
                <dd>
                  {percent(metrics.aiMiss.rate)}
                  <small>
                    {metrics.aiMiss.count} / {metrics.aiMiss.of} 份 AI 样本
                  </small>
                </dd>
              </div>
              <div>
                <dt>人写／AI 不确定</dt>
                <dd>
                  {percent(binaryCount ? uncertainCount / binaryCount : null)}
                  <small>
                    {uncertainCount} / {binaryCount} 份二元样本
                  </small>
                </dd>
              </div>
            </dl>
            <div className="evaluation-legend">
              <span className="low">较低</span>
              <span className="uncertain">不确定</span>
              <span className="high">较高</span>
            </div>
            <div className="evaluation-distributions">
              {(["human", "ai", "mixed"] as const).map((label) => (
                <LabelDistribution key={label} records={selected} label={label} />
              ))}
            </div>
            <div className="table-scroll">
              <table className="evaluation-metrics">
                <caption>误报、漏报和不确定比例</caption>
                <thead>
                  <tr>
                    <th>指标及定义</th>
                    <th>样本比例</th>
                    <th>95% Wilson 区间</th>
                  </tr>
                </thead>
                <tbody>
                  <RateRow
                    title="人写误报"
                    detail="人写样本被判为较高"
                    value={metrics.humanFalseFlag}
                  />
                  <RateRow title="AI 漏报" detail="AI 样本被判为较低" value={metrics.aiMiss} />
                  <RateRow
                    title="人写不确定"
                    detail="不能计作正确识别"
                    value={metrics.humanUncertain}
                  />
                  <RateRow
                    title="AI 不确定"
                    detail="不能计作正确识别"
                    value={metrics.aiUncertain}
                  />
                  <RateRow
                    title="文本充分度低"
                    detail="只表示文本长度及一致性"
                    value={metrics.insufficient}
                  />
                </tbody>
              </table>
            </div>
            <p className="fine">
              区间反映这些样本的比例，不是总体性能保证。同组的多个版本可能相关；未知作者组别不能证明非母语写作表现。混合稿只显示档位分布，不计算二元准确率或
              AI 字数比例。
            </p>
            <p className="fine">
              整轮请求时延（不受筛选影响）：均值{" "}
              {bundle.report.latency.mean_ms?.toFixed(1) ?? "未记录"} ms，P95{" "}
              {bundle.report.latency.p95_ms?.toFixed(1) ?? "未记录"} ms。
            </p>
          </section>
          <section className="panel evaluation-calibration" aria-labelledby="calibration-title">
            <h3 id="calibration-title">校准与独立验证</h3>
            <p>
              只用校准集的人写／AI
              样本拟合阈值，测试集与混合稿不参与选择。筛选不会重新拟合阈值；以下展示整轮数据的验证结果。
            </p>
            <p className="fine">
              要求每类、每集合至少 30 个独立样本组，误报和漏报的 95% Wilson 上界各不超过
              20%，并核验来源和训练数据重叠证据。
            </p>
            {bundle.calibration ? (
              <div className="calibration-cards">
                {Object.entries(bundle.calibration.languages).map(
                  ([lang, entry]) =>
                    entry && <CalibrationCard key={lang} lang={lang} entry={entry} />,
                )}
              </div>
            ) : (
              <p>这些样本没有完整的 calibration／test 分组，本次只汇总表现，不拟合阈值。</p>
            )}
          </section>
          <section className="panel evaluation-samples">
            <h3>逐样本记录</h3>
            <div className="table-scroll">
              <table>
                <caption>当前筛选的预测记录（每页 25 份）</caption>
                <thead>
                  <tr>
                    <th>编号／来源</th>
                    <th>真值标签</th>
                    <th>语言／集合</th>
                    <th>模型分数／档位</th>
                    <th>长度／充分度</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((record) => (
                    <tr key={record.id}>
                      <th scope="row">
                        {record.id}
                        <small>
                          {record.source_url ? (
                            <a href={record.source_url} target="_blank" rel="noreferrer">
                              {record.source}
                            </a>
                          ) : (
                            record.source
                          )}
                        </small>
                      </th>
                      <td>{LABEL[record.label]}</td>
                      <td>
                        {record.lang === "zh" ? "中文" : "英文"}
                        <small>{SPLIT[record.split]}</small>
                      </td>
                      <td>
                        {percent(record.score)}
                        <small>{VERDICT_LABEL[record.verdict]}</small>
                      </td>
                      <td>
                        {record.char_count ?? "未知"} 字符
                        <small>
                          充分度{" "}
                          {record.confidence === "low"
                            ? "低"
                            : record.confidence === "medium"
                              ? "中"
                              : record.confidence === "high"
                                ? "高"
                                : "未知"}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!selected.length && <p>当前筛选没有样本，请调整条件。</p>}
            <div className="evaluation-pagination">
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>
                第 {page + 1} / {Math.max(1, Math.ceil(selected.length / 25))} 页
              </span>
              <button
                type="button"
                disabled={(page + 1) * 25 >= selected.length}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
