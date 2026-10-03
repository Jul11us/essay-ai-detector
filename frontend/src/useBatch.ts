import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_BATCH_FILES, initialRows, runBatch, type BatchRow, type RunBatchOptions } from "./batch";
import type { Outcome } from "./aggregate";
import type { Lang } from "./types";
import { withTaskLock } from "./tasks";

/** 多文件批量状态；成功结果和详情修改在重试、取消和继续时保留。 */
export function useBatch(options: RunBatchOptions = {}, taskId: string | null = null) {
  const [files, setFilesState] = useState<File[]>([]);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef(false);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const updateResult = useCallback((index: number, result: Outcome) => {
    setRows((cur) => {
      const row = cur[index];
      if (!row?.result || row.result === result) return cur;
      return cur.map((old, i) => (i === index ? { ...old, result } : old));
    });
  }, []);

  /** 超出上限时保留原列表，让用户重新选择；不会静默丢弃文件。 */
  function setFiles(next: File[]): boolean {
    if (next.length > MAX_BATCH_FILES) {
      setSelectionError(`你选择了 ${next.length} 个文件，每批最多 ${MAX_BATCH_FILES} 个。请分批选择；本次选择未添加。`);
      return false;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    stopRef.current = false;
    setFilesState(next);
    setRows([]);
    setRunning(false);
    setStopping(false);
    setSelectionError(null);
    return true;
  }

  async function runUnlocked(indices: number[]) {
    if (abortRef.current || !indices.length) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stopRef.current = false;
    setStopping(false);
    setRows((cur) => {
      const source = cur.length ? cur : initialRows(files);
      return source.map((row, i) => indices.includes(i)
        ? { name: row.name, status: "queued", lang: row.lang, languageOverride: row.languageOverride } : row);
    });
    setRunning(true);
    try {
      await runBatch(files, (index, row) => {
        if (abortRef.current !== ctrl) return;
        setRows((cur) => cur.map((old, i) => i === index
          ? { ...row, languageOverride: old.languageOverride, result: row.result ?? old.result } : old));
      }, ctrl.signal, {
        ...options, indices, stopAfterCurrent: () => stopRef.current,
        languageOverrides: Object.fromEntries(rows.flatMap((row, i) => row.languageOverride ? [[i, row.languageOverride]] : [])),
      });
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setRunning(false);
        setStopping(false);
      }
    }
  }

  async function run(indices: number[], leaseId: string | null = taskId) {
    try { await withTaskLock(leaseId, () => runUnlocked(indices)); }
    catch (err) { setSelectionError(err instanceof Error ? err.message : "任务无法运行"); }
  }

  async function start(leaseId: string | null = taskId) {
    const indices = files.flatMap((_, i) => rows[i]?.status === "done" ? [] : [i]);
    await run(indices, leaseId);
  }

  async function retry(index: number) {
    if (rows[index]?.status !== "error" && rows[index]?.status !== "cancelled") return;
    await run([index]);
  }

  async function retryFailed() {
    await run(rows.flatMap((row, i) => row.status === "error" ? [i] : []));
  }

  function cancel() {
    if (!abortRef.current) return;
    stopRef.current = true;
    setStopping(true);
  }

  function setLanguage(index: number, lang: Lang | null) {
    if (abortRef.current || rows[index]?.status === "done") return;
    setRows((cur) => cur.map((row, i) => i === index ? { ...row, languageOverride: lang ?? undefined } : row));
  }

  function restore(nextFiles: File[], nextRows: BatchRow[]) {
    abortRef.current?.abort(); abortRef.current = null; stopRef.current = false;
    setFilesState(nextFiles); setRows(nextRows); setRunning(false); setStopping(false); setSelectionError(null);
  }
  return { files, rows, running, stopping, selectionError, setFiles, start, retry, retryFailed, cancel, updateResult, setLanguage, restore };
}
