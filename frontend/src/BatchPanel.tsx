import type { BatchRow } from "./batch";
import { VERDICT_LABEL, formatPercent } from "./copy";
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
            <th scope="col">模型原始分数</th>
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
        分数是各文件单独计算的模型原始分数，未经样本校准。不要用它在文件之间排名，也不能据此认定某个文件的来源。
      </p>
    </section>
  );
}
