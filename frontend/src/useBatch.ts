import { useCallback, useRef, useState } from "react";
import { MAX_BATCH_FILES, initialRows, runBatch, type BatchRow } from "./batch";
import type { DetectOk } from "./types";

/** 多文件批量检测的状态。文件列表和逐个文件的进度都在这里。 */
export function useBatch() {
  const [files, setFilesState] = useState<File[]>([]);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /** 详情里的逐句定位和单段重测写回所属文件，切换后仍保留，汇总导出也用最新分数。 */
  const updateResult = useCallback((index: number, result: DetectOk) => {
    setRows((cur) => {
      const row = cur[index];
      if (!row?.result || row.result === result) return cur;
      return cur.map((old, i) => (i === index ? { ...old, result } : old));
    });
  }, []);

  /** 换一批文件（或清空）：丢掉旧的汇总。 */
  function setFiles(next: File[]) {
    abortRef.current?.abort();
    setFilesState(next.slice(0, MAX_BATCH_FILES));
    setRows([]);
    setRunning(false);
  }

  async function start(lang: "zh" | "en") {
    if (running || !files.length) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRows(initialRows(files));
    setRunning(true);
    try {
      await runBatch(
        files,
        lang,
        (index, row) => {
          if (abortRef.current !== ctrl) return;
          setRows((cur) => cur.map((old, i) => (i === index ? row : old)));
        },
        ctrl.signal,
      );
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return { files, rows, running, setFiles, start, cancel, updateResult };
}
