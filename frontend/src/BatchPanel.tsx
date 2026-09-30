import type { BatchRow } from "./batch";
import { AI_RATE_LABEL, AI_RATE_NOTE, VERDICT_LABEL, formatPercent } from "./copy";
import { buildBatchCsv, downloadCsv } from "./export";
import type { DetectOk } from "./types";

const STATUS_LABEL = {
  queued: "排队中",
  running: "正在检测…",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
} as const;

export function BatchPanel({
  rows,
  running,
  openIndex,
  onOpen,
  onCancel,
}: {
  rows: BatchRow[];
  running: boolean;
  openIndex: number | null;
  onOpen: (index: number, result: DetectOk) => void;
  onCancel: () => void;
}) {
  if (!rows.length) return null;
  const finished = rows.filter((r) => r.status !== "queued" && r.status !== "running").length;
  return (
    <section className="batch" aria-labelledby="batch-title">
      <div className="batch-head">
        <h2 id="batch-title">批量检测汇总</h2>
        <span role="status">
          {running ? `已完成 ${finished} / ${rows.length}` : `共 ${rows.length} 个文件，已处理 ${finished} 个`}
        </span>
        {running && (
          <button type="button" className="text-btn" onClick={onCancel}>
            取消批量检测
          </button>
        )}
        {!running && (
          <button
            type="button"
            className="text-btn"
            onClick={() => downloadCsv(buildBatchCsv(rows), "ai-rate-batch.csv")}
          >
            导出汇总 CSV
          </button>
        )}
      </div>
      <table>
        <caption className="sr-only">每个文件单独检测的结果</caption>
        <thead>
          <tr>
            <th scope="col">文件</th>
            <th scope="col">状态</th>
            <th scope="col">{AI_RATE_LABEL}</th>
            <th scope="col">档位</th>
            <th scope="col">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.name}:${i}`} aria-current={openIndex === i ? "true" : undefined}>
              <th scope="row">{row.name}</th>
              <td>
                {STATUS_LABEL[row.status]}
                {row.message && <span className="fail"> {row.message}</span>}
              </td>
              <td>{row.result ? `${formatPercent(row.result.score)}%` : "—"}</td>
              <td>{row.result ? VERDICT_LABEL[row.result.verdict] : "—"}</td>
              <td>
                {row.result && (
                  <button
                    type="button"
                    className="text-btn"
                    aria-label={`查看 ${row.name} 的逐句结果`}
                    onClick={() => onOpen(i, row.result as DetectOk)}
                  >
                    查看
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine">
        {AI_RATE_NOTE}各文件单独计算，不能据此认定文字来源。
      </p>
    </section>
  );
}
