import { useState } from "react";
import type { Outcome } from "./aggregate";
import { snapshotResult } from "./versions";

export async function requestWordReport(data: Outcome): Promise<Blob> {
  const response = await fetch("/api/reports/word", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: snapshotResult(data) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message || "Word 报告导出失败，请检查检测服务后重试。");
  }
  if (!response.headers.get("content-type")?.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
    throw new Error("服务没有返回 Word 文件，请重启最新检测服务后重试。");
  }
  return response.blob();
}

export function WordReportButton({ data, combined = false }: { data: Outcome; combined?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = async () => {
    setBusy(true); setError("");
    try {
      const blob = await requestWordReport(data);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = combined ? "ai-writing-bilingual-report.docx" : `ai-writing-${data.lang}-report.docx`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Word 报告导出失败，请重试。");
    } finally { setBusy(false); }
  };
  return <span className="word-export">
    <button type="button" className="text-btn" disabled={busy} onClick={() => void download()}>
      {busy ? "正在生成 Word…" : combined ? "导出中英 Word 报告" : "导出 Word 标注报告"}
    </button>
    {error && <span className="fail" role="alert">{error}</span>}
  </span>;
}
