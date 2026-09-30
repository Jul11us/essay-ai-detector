import type { ReactNode } from "react";
import { buildBilingualCsv, buildResultJson, downloadCsv, downloadJson } from "./export";
import { buildBilingualReport, downloadReport, printReport } from "./report";
import type { BilingualOk, DetectOk } from "./types";
import { isSectionErr } from "./types";

export function BilingualResult({
  data,
  render,
}: {
  data: BilingualOk;
  render: (side: "en" | "zh", doc: DetectOk) => ReactNode;
}) {
  return (
    <div className="bilingual">
      <p className="fine">{data.note}</p>
      <div className="result-actions">
        <button
          type="button"
          className="text-btn"
          onClick={() => downloadReport(buildBilingualReport(data), "ai-rate-report.html")}
        >
          导出合并报告
        </button>
        <button type="button" className="text-btn" onClick={() => printReport(buildBilingualReport(data))}>
          打印合并报告
        </button>
        <button type="button" className="text-btn" onClick={() => downloadJson(buildResultJson(data), "ai-rate-result.json")}>
          导出合并 JSON
        </button>
        <button type="button" className="text-btn" onClick={() => downloadCsv(buildBilingualCsv(data), "ai-rate-result.csv")}>
          导出合并 CSV
        </button>
      </div>
      <h2 className="paras-title">英文部分</h2>
      {data.en && isSectionErr(data.en) && <p className="fail">{data.en.message}</p>}
      {data.en && !isSectionErr(data.en) && render("en", data.en)}
      {!data.en && <p className="hint">没有分出英文。</p>}
      <h2 className="paras-title">中文部分</h2>
      {data.zh && isSectionErr(data.zh) && <p className="fail">{data.zh.message}</p>}
      {data.zh && !isSectionErr(data.zh) && render("zh", data.zh)}
      {!data.zh && <p className="hint">没有分出中文。</p>}
    </div>
  );
}
