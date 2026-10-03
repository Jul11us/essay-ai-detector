import { useEffect, useRef, useState } from "react";
import { BatchPanel } from "./BatchPanel";
import { BilingualResult } from "./BilingualResult";
import { InputPanel } from "./InputPanel";
import { ResultCard } from "./ResultView";
import { VersionPanel } from "./VersionPanel";
import type { Side } from "./aggregate";
import { canSubmit } from "./copy";
import { EXAMPLES } from "./examples";
import { suggestLanguage } from "./languageHint";
import { useBatch } from "./useBatch";
import { useDetector } from "./useDetector";
import { useFileInput } from "./useFileInput";
import { useModelStatus } from "./useModelStatus";
import type { DetectOk, Lang, SentenceReview } from "./types";
import { isBilingual } from "./types";
import { EvaluationPanel } from "./EvaluationPanel";
import { BrandMark, ReadingGuide, WorkspaceIntro } from "./WorkspaceIntro";
import { useTaskLibrary } from "./useTaskLibrary";
import { TaskCenter } from "./TaskCenter";
import { interruptedBatch, loadTaskFiles, withTaskLock, type SavedTask, type EvaluationTask } from "./tasks";

const DISCLAIMER =
  "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。检测在本机完成，不是知网或 Turnitin 的检测结果。";

export default function App() {
  const [view, setView] = useState<"detect" | "evaluation" | "tasks">("detect");
  const library = useTaskLibrary();
  const [singleTaskId, setSingleTaskId] = useState<string | null>(null);
  const [batchTaskId, setBatchTaskId] = useState<string | null>(null);
  const [evaluationTaskId, setEvaluationTaskId] = useState<string | null>(null);
  const [restoredEvaluation, setRestoredEvaluation] = useState<{ task: EvaluationTask; files: File[]; token: number } | null>(null);
  const evaluationControl = useRef<{ cancel: () => void } | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [evaluationBusy, setEvaluationBusy] = useState(false);
  const [awaitingResult, setAwaitingResult] = useState(false);
  const [lang, setLang] = useState<Lang | null>(null);
  const [text, setText] = useState("");
  const [enText, setEnText] = useState("");
  const [zhText, setZhText] = useState("");
  const [mixOpen, setMixOpen] = useState(false);
  const status = useModelStatus();
  const detector = useDetector();
  const fileInput = useFileInput(
    detector.reset,
  );
  const { file, filePreview, previewBusy, previewError, fileInputRef, onFile, selection, setSelection } = fileInput;
  const batch = useBatch({}, batchTaskId);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const { busy, result, error } = detector;
  const { updateResult: updateBatchResult } = batch;

  useEffect(() => {
    if (!awaitingResult || busy) return;
    if (!result && !error) return;
    if (result) {
      const output = document.getElementById("detection-results");
      output?.focus({ preventScroll: true });
      output?.scrollIntoView?.({ block: "start" });
    }
    setAwaitingResult(false);
  }, [awaitingResult, busy, result, error]);

  useEffect(() => {
    if (openIndex !== null && result) {
      updateBatchResult(openIndex, result);
    }
  }, [openIndex, result, updateBatchResult]);
  const inBatch = batch.files.length > 0;
  const batchPending = batch.files.filter((_, i) => batch.rows[i]?.status !== "done").length;
  const locked = busy || batch.running || evaluationBusy || taskSaving;

  const { get: getTask, save: saveTask } = library;
  useEffect(() => {
    if (!batchTaskId || !batch.rows.length) return;
    const task = getTask(batchTaskId);
    if (task?.kind !== "batch") return;
    saveTask({ ...task, rows: batch.rows, state: batch.running ? "running" : batch.rows.every((r) => r.status === "done") ? "complete" : "paused" });
  }, [batchTaskId, batch.rows, batch.running, getTask, saveTask]);
  useEffect(() => {
    if (!singleTaskId) return;
    const task = getTask(singleTaskId);
    if (task?.kind !== "single") return;
    if (!busy && !result && !error) return;
    saveTask({ ...task, result, message: error || undefined, state: busy ? "running" : result ? "complete" : error ? "failed" : "paused" });
  }, [singleTaskId, result, busy, error, getTask, saveTask]);

  const langReady =
    lang === "bi"
      ? Boolean(status?.models.zh && status?.models.en)
      : lang
        ? Boolean(status?.models[lang])
        : false;
  const readyToSubmit =
    (inBatch
      ? Boolean(status?.models.zh || status?.models.en) && batchPending > 0 && !locked
      : canSubmit(lang, text, file, { en: enText, zh: zhText }) && langReady && !locked &&
        (!file || (filePreview !== null && !previewBusy && !previewError && selection?.length !== 0)));
  const statusLine = status?.detail ?? "正在连接检测服务…";
  const runtimeNote = [
    status?.runtime?.en === "onnx-int8" ? "英文 INT8" : "",
    status?.runtime?.zh === "onnx-int8" ? "中文 INT8" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const suggestion = suggestLanguage(file ? filePreview?.text ?? "" : [text, enText, zhText].join("\n"));

  // 选一个文件走单篇流程（先预览）；选多个走批量流程（逐个检测，汇总成表）。
  const onFiles = (list: File[]) => {
    if (list.length > 1) {
      if (!batch.setFiles(list)) return;
      setBatchTaskId(null); setSingleTaskId(null);
      setOpenIndex(null);
      onFile(null);
      return;
    }
    setOpenIndex(null);
    setBatchTaskId(null); setSingleTaskId(null);
    batch.setFiles([]);
    onFile(list[0] ?? null);
  };

  const onSubmit = async () => {
    if (!readyToSubmit || taskSaving) return;
    setTaskSaving(true);
    try {
      if (inBatch) {
        let id = batchTaskId;
        if (!id) {
          const task = await library.create({ kind: "batch", rows: [] }, batch.files, `批量检测 · ${batch.files.length} 个文件`);
          id = task.id; setBatchTaskId(id);
        }
        setSingleTaskId(null); detector.reset(); setOpenIndex(null); setTaskSaving(false);
        await batch.start(id); return;
      }
      const input = { lang, text, en: enText, zh: zhText, selection, source_sha256: filePreview?.source_sha256 };
      const previous = singleTaskId ? library.get(singleTaskId) : null;
      const task = previous?.kind === "single" && previous.state !== "complete" && JSON.stringify(previous.input) === JSON.stringify(input) ? previous : await library.create({ kind: "single", input, preview: filePreview, result: null }, file ? [file] : [], file?.name || `文字检测 · ${lang === "en" ? "英文" : lang === "bi" ? "中英分开" : "中文"}`);
      setSingleTaskId(task.id); setBatchTaskId(null); setOpenIndex(null); batch.setFiles([]); setTaskSaving(false);
      await withTaskLock(task.id, () => { setAwaitingResult(true); return detector.submit({ ...input, file }); });
    } catch (err) { detector.setError(err instanceof Error ? err.message : "任务无法保存或开始。"); }
    finally { setTaskSaving(false); }
  };

  const loadExample = (example: (typeof EXAMPLES)[number]) => {
    batch.setFiles([]);
    setBatchTaskId(null); setSingleTaskId(null);
    setOpenIndex(null);
    onFile(null);
    setLang(example.lang);
    setText(example.text);
    setEnText("");
    setZhText("");
    setMixOpen(example.lang === "bi");
  };

  const openTask = async (task: SavedTask) => {
    if (navigator.locks && (await navigator.locks.query()).held?.some((lock) => lock.name === `writing-lens:${task.id}`)) throw new Error("这个任务正在其他页面运行，请等待完成后再恢复。");
    let restoredFiles: File[];
    try { restoredFiles = await loadTaskFiles(task); }
    catch (err) {
      if (task.kind === "single" && task.result) { setSingleTaskId(task.id); setBatchTaskId(null); batch.setFiles([]); onFile(null); detector.adopt(task.result); setView("detect"); setAwaitingResult(true); return; }
      throw err;
    }
    setSingleTaskId(null); setBatchTaskId(null); setOpenIndex(null); detector.reset();
    if (task.kind === "evaluation") {
      setRestoredEvaluation({ task, files: restoredFiles, token: Date.now() }); setView("evaluation"); return;
    }
    setView("detect");
    if (task.kind === "batch") {
      onFile(null); batch.restore(restoredFiles, interruptedBatch(task.rows)); setBatchTaskId(task.id);
      if (!task.rows.length) batch.restore(restoredFiles, restoredFiles.map((f) => ({ name: f.name, status: "cancelled" })));
    } else {
      batch.setFiles([]); setLang(task.input.lang); setText(task.input.text); setEnText(task.input.en); setZhText(task.input.zh); setMixOpen(task.input.lang === "bi" && !!task.input.text);
      fileInput.restore(restoredFiles[0] || null, task.preview, task.input.selection); setSingleTaskId(task.id);
      if (task.result) { detector.adopt(task.result); setAwaitingResult(true); }
    }
  };
  const deleteTask = async (id: string) => {
    if (!await library.remove(id)) return;
    if (singleTaskId === id) setSingleTaskId(null);
    if (batchTaskId === id) setBatchTaskId(null);
  };

  function cardProps(side: Side, data: DetectOk) {
    return {
      data,
      copied: detector.copied === data.lang,
      onCopy: detector.copy,
      active: view === "detect",
      locked: locked || detector.rechecking !== null,
      reviewEpoch: result?.version_history?.at(-1)?.id,
      onSaveVersion: () => detector.saveVersion(),
      onRecheck: (index: number, draft: string) => detector.recheck(side, data, index, draft),
      onScan: (index: number) => detector.scan(side, data, index),
      onReview: (para: number, sentence: number, text: string, review: SentenceReview | null) => detector.reviewSentence(side, para, sentence, text, review),
      recheckingIndex: detector.rechecking?.side === side ? detector.rechecking.index : null,
      scanProgress: detector.scanProgress,
    };
  }

  return (
    <main className="page">
      <a className="skip-link" href="#workspace-content">跳到工作区</a>
      <header className="mast">
        <div className="brand">
          <BrandMark />
          <div><h1>作文 AI 写作检测</h1><span>WRITING LENS / 本机复核工作台</span></div>
        </div>
      <nav className="workspace-nav" aria-label="检测与评测">
        <button type="button" aria-pressed={view === "detect"} disabled={locked} onClick={() => setView("detect")}><span aria-hidden="true">01</span> 作文检测</button>
        <button type="button" aria-pressed={view === "evaluation"} disabled={locked} onClick={() => setView("evaluation")}><span aria-hidden="true">02</span> 样本评测</button>
        <button type="button" aria-pressed={view === "tasks"} onClick={() => setView("tasks")}><span aria-hidden="true">03</span> 任务中心</button>
      </nav>
      </header>
      <div id="workspace-content" tabIndex={-1}>
      <EvaluationPanel active={view === "evaluation"} models={status?.models} onBusyChange={setEvaluationBusy} library={library} restored={restoredEvaluation} onTaskChange={setEvaluationTaskId} controlRef={evaluationControl} />
      {view === "tasks" && <TaskCenter tasks={library.tasks} ready={library.ready} error={library.error} pending={library.pending} locked={locked} activeIds={[...(busy && singleTaskId ? [singleTaskId] : []), ...(batch.running && batchTaskId ? [batchTaskId] : []), ...(evaluationBusy && evaluationTaskId ? [evaluationTaskId] : [])]} onOpen={openTask} onRename={library.rename} onDelete={deleteTask} onStop={(task) => { if (task.kind === "batch") batch.cancel(); else if (task.kind === "evaluation") evaluationControl.current?.cancel(); else detector.cancel(); }} />}
      <div hidden={view !== "detect"}>
      <WorkspaceIntro />
      {library.error && <p role="status" className="task-save-warning">{library.error}</p>}
      {taskSaving && <p role="status">正在保存任务输入到本机…</p>}
      <div className="writing-workspace" id="writing-workspace" tabIndex={-1}>
      <InputPanel
        status={status}
        statusLine={statusLine}
        runtimeNote={runtimeNote}
        lang={lang}
        setLang={setLang}
        suggestion={suggestion}
        text={text}
        setText={setText}
        enText={enText}
        setEnText={setEnText}
        zhText={zhText}
        setZhText={setZhText}
        mixOpen={mixOpen}
        setMixOpen={setMixOpen}
        file={file}
        filePreview={filePreview}
        selection={selection}
        onSelection={setSelection}
        previewBusy={previewBusy}
        previewError={previewError}
        fileInputRef={fileInputRef}
        onFile={onFile}
        forgetResult={detector.forgetResult}
        busy={busy}
        locked={locked}
        batchFiles={batch.files}
        onFiles={onFiles}
        batchRunning={batch.running}
        batchSelectionError={batch.selectionError}
        batchPending={batchPending}
        elapsed={detector.elapsed}
        langReady={langReady}
        readyToSubmit={readyToSubmit}
        onSubmit={onSubmit}
        onCancel={detector.cancel}
      />
      <ReadingGuide locked={locked} onExample={loadExample} />
      </div>
      <aside className="notice"><span className="notice-label">如何理解结果</span>{DISCLAIMER}</aside>

      <BatchPanel
        rows={batch.rows}
        running={batch.running}
        stopping={batch.stopping}
        openIndex={openIndex}
        onOpen={(index, data) => {
          setOpenIndex(index);
          detector.adopt(data);
          setAwaitingResult(true);
        }}
        onCancel={batch.cancel}
        onLanguage={batch.setLanguage}
        onRetry={(index) => {
          if (openIndex === index) { setOpenIndex(null); detector.reset(); }
          void batch.retry(index);
        }}
        onRetryFailed={() => {
          if (openIndex !== null && batch.rows[openIndex]?.status === "error") {
            setOpenIndex(null); detector.reset();
          }
          void batch.retryFailed();
        }}
      />

      {error && (
        <p className="fail" role="alert">
          {error}
        </p>
      )}

      {result && <div id="detection-results" className="detection-results" tabIndex={-1} role="region" aria-label="检测结果">
      <VersionPanel key={`versions-${openIndex ?? singleTaskId ?? "single"}`} data={result} locked={locked || detector.rechecking !== null || detector.scanProgress !== null} onSave={detector.saveVersion} onRestore={detector.restoreVersion} />
      {!isBilingual(result) && (
        <ResultCard key={openIndex ?? "single"} {...cardProps("single", result)} />
      )}
      {isBilingual(result) && (
        <BilingualResult
          key={openIndex ?? "single-bi"}
          data={result}
          render={(side, doc) => <ResultCard {...cardProps(side, doc)} />}
        />
      )}
      </div>}
      </div>
      </div>
      <footer className="site-footer"><span>WRITING LENS</span><p>文字值得仔细阅读。分数只是复核的起点。</p><span>本机 · 开源模型</span></footer>
    </main>
  );
}
