import { useState } from "react";
import type { Outcome } from "./aggregate";
import { batchParts, type BatchRow, type BatchStatus } from "./batch";
import { AI_SCORE_NOTE, AI_SCORE_SHORT, VERDICT_LABEL, formatPercent } from "./copy";
import { buildBatchCsv, downloadCsv } from "./export";
import { LANGUAGE_LABEL } from "./languageHint";
import type { Lang } from "./types";

const STATUS_LABEL = {
  queued: "排队中",
  running: "正在检测…",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
} as const;

type Filter = "all" | BatchStatus;
type Sort = "original" | "score-desc" | "score-asc" | "name";

export function BatchPanel({
  rows,
  running,
  stopping,
  openIndex,
  onOpen,
  onCancel,
  onRetry,
  onRetryFailed,
  onLanguage,
}: {
  rows: BatchRow[];
  running: boolean;
  stopping: boolean;
  openIndex: number | null;
  onOpen: (index: number, result: Outcome) => void;
  onCancel: () => void;
  onRetry: (index: number) => void;
  onRetryFailed: () => void;
  onLanguage: (index: number, lang: Lang | null) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("original");
  if (!rows.length) return null;
  const completed = rows.filter((row) => row.status === "done").length;
  const failed = rows.filter((row) => row.status === "error").length;
  const cancelled = rows.filter((row) => row.status === "cancelled").length;
  const score = (row: BatchRow) => {
    const parts = batchParts(row.result);
    return parts.length ? Math.max(...parts.map((part) => part.score)) : null;
  };
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => filter === "all" || row.status === filter)
    .sort((a, b) => {
      if (sort === "name") return a.row.name.localeCompare(b.row.name) || a.index - b.index;
      if (sort === "original") return a.index - b.index;
      const left = score(a.row),
        right = score(b.row);
      if (left === null) return right === null ? a.index - b.index : 1;
      if (right === null) return -1;
      return (sort === "score-desc" ? right - left : left - right) || a.index - b.index;
    });

  return (
    <section className="batch" aria-labelledby="batch-title">
      <div className="batch-head">
        <h2 id="batch-title">批量检测汇总</h2>
        <span role="status">
          共 {rows.length} 个文件 · 完成 {completed} · 失败 {failed} · 已取消 {cancelled}
        </span>
        {running && (
          <button type="button" className="text-btn" disabled={stopping} onClick={onCancel}>
            {stopping ? "等待当前文件完成…" : "取消后续文件"}
          </button>
        )}
        {failed > 0 && (
          <button type="button" className="text-btn" disabled={running} onClick={onRetryFailed}>
            重试失败文件（{failed}）
          </button>
        )}
        <button
          type="button"
          className="text-btn"
          onClick={() => downloadCsv(buildBatchCsv(rows), "ai-rate-batch.csv")}
        >
          导出全部汇总 CSV
        </button>
      </div>
      {stopping && (
        <p className="fine" role="status">
          当前文件会继续完成；尚未开始的文件将取消，完成结果会保留。
        </p>
      )}
      <div className="batch-tools">
        <label>
          结果筛选
          <select
            aria-label="批量结果筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="all">全部文件</option>
            <option value="done">已完成</option>
            <option value="error">失败或部分完成</option>
            <option value="cancelled">已取消</option>
            <option value="running">正在检测</option>
            <option value="queued">排队中</option>
          </select>
        </label>
        <label>
          排序
          <select
            aria-label="批量结果排序"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="original">文件选择顺序</option>
            <option value="score-desc">最高分从高到低</option>
            <option value="score-asc">最高分从低到高</option>
            <option value="name">文件名</option>
          </select>
        </label>
        <span className="fine">
          显示 {visible.length} / {rows.length} 个文件。混合文件按两种语言中较高的分数排序。
        </span>
      </div>
      <div className="batch-table-wrap">
        <table>
          <caption className="sr-only">每个文件单独检测的结果</caption>
          <thead>
            <tr>
              <th scope="col">文件</th>
              <th scope="col">状态</th>
              <th scope="col">语言</th>
              <th scope="col">{AI_SCORE_SHORT}</th>
              <th scope="col">档位</th>
              <th scope="col">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, index }) => {
              const parts = batchParts(row.result);
              return (
                <tr
                  key={`${row.name}:${index}`}
                  aria-current={openIndex === index ? "true" : undefined}
                >
                  <th scope="row">{row.name}</th>
                  <td>
                    {row.status === "error" && parts.length ? "部分完成" : STATUS_LABEL[row.status]}
                    {row.message && (
                      <span
                        className={row.status === "error" ? "fail batch-message" : "batch-message"}
                      >
                        {row.message}
                      </span>
                    )}
                  </td>
                  <td>
                    <span>{row.lang ? LANGUAGE_LABEL[row.lang] : "—"}</span>
                    {row.status !== "done" && (
                      <select
                        className="batch-language"
                        aria-label={`检测 ${row.name} 的语言`}
                        disabled={running}
                        value={row.languageOverride ?? "auto"}
                        onChange={(e) =>
                          onLanguage(
                            index,
                            e.target.value === "auto" ? null : (e.target.value as Lang),
                          )
                        }
                      >
                        <option value="auto">自动识别</option>
                        <option value="zh">中文</option>
                        <option value="en">英文</option>
                        <option value="bi">中英分开</option>
                      </select>
                    )}
                    {row.languageOverride && row.status !== "done" && (
                      <span className="batch-message">
                        重试时使用{LANGUAGE_LABEL[row.languageOverride]}
                      </span>
                    )}
                  </td>
                  <td>
                    {parts.length
                      ? parts.map((part) => (
                          <span className="batch-part" key={part.lang}>
                            {parts.length > 1 || row.lang === "bi"
                              ? `${part.lang === "en" ? "英文" : "中文"} `
                              : ""}
                            {formatPercent(part.score)}%
                          </span>
                        ))
                      : "—"}
                  </td>
                  <td>
                    {parts.length
                      ? parts.map((part) => (
                          <span className="batch-part" key={part.lang}>
                            {VERDICT_LABEL[part.verdict]}
                          </span>
                        ))
                      : "—"}
                  </td>
                  <td>
                    {row.result && (
                      <button
                        type="button"
                        className="text-btn"
                        aria-label={`查看 ${row.name} 的逐句结果`}
                        onClick={() => onOpen(index, row.result as Outcome)}
                      >
                        查看
                      </button>
                    )}
                    {(row.status === "error" || row.status === "cancelled") && (
                      <button
                        type="button"
                        className="text-btn"
                        disabled={running}
                        aria-label={`重试 ${row.name}`}
                        onClick={() => onRetry(index)}
                      >
                        重试
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr>
                <td colSpan={6}>没有符合筛选条件的文件。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="fine">
        {AI_SCORE_NOTE}各文件和语言单独计算，不能据此认定文字来源。导出包含全部文件，不受筛选影响。
      </p>
    </section>
  );
}
