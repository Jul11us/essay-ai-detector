import { useEffect, useState } from "react";
import { BatchPanel } from "./BatchPanel";
import { BilingualResult } from "./BilingualResult";
import { InputPanel } from "./InputPanel";
import { Compare, ResultCard } from "./ResultView";
import type { Side } from "./aggregate";
import { canSubmit } from "./copy";
import { EXAMPLES } from "./examples";
import { suggestLanguage } from "./languageHint";
import { useBatch } from "./useBatch";
import { useDetector } from "./useDetector";
import { useFileInput } from "./useFileInput";
import { useModelStatus } from "./useModelStatus";
import type { DetectOk, Lang } from "./types";
import { isBilingual, isSectionErr } from "./types";

const DISCLAIMER =
  "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。检测在本机完成，不是知网或 Turnitin 的检测结果。";

export default function App() {
  const [lang, setLang] = useState<Lang | null>(null);
  const [text, setText] = useState("");
  const [enText, setEnText] = useState("");
  const [zhText, setZhText] = useState("");
  const [mixOpen, setMixOpen] = useState(false);
  const status = useModelStatus();
  const detector = useDetector();
  const { file, filePreview, previewBusy, previewError, fileInputRef, onFile } = useFileInput(
    detector.reset,
  );
  const batch = useBatch();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const { busy, result, baseline, error } = detector;
  const { updateResult: updateBatchResult } = batch;

  useEffect(() => {
    if (openIndex !== null && result && !isBilingual(result)) {
      updateBatchResult(openIndex, result);
    }
  }, [openIndex, result, updateBatchResult]);
  const inBatch = batch.files.length > 0;
  const locked = busy || batch.running;

  const langReady =
    lang === "bi"
      ? Boolean(status?.models.zh && status?.models.en)
      : lang
        ? Boolean(status?.models[lang])
        : false;
  const readyToSubmit =
    (inBatch
      ? lang !== null && lang !== "bi" && langReady && !locked
      : canSubmit(lang, text, file, { en: enText, zh: zhText }) && langReady && !locked &&
        (!file || (filePreview !== null && !previewBusy && !previewError)));
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
    setOpenIndex(null);
    if (list.length > 1) {
      onFile(null);
      batch.setFiles(list);
      return;
    }
    batch.setFiles([]);
    onFile(list[0] ?? null);
  };

  const onSubmit = () => {
    if (inBatch) {
      if (lang !== "zh" && lang !== "en") return;
      detector.reset();
      setOpenIndex(null);
      void batch.start(lang);
      return;
    }
    setOpenIndex(null);
    batch.setFiles([]);
    void detector.submit({ lang, text, file, en: enText, zh: zhText });
  };

  const loadExample = (example: (typeof EXAMPLES)[number]) => {
    batch.setFiles([]);
    setOpenIndex(null);
    onFile(null);
    setLang(example.lang);
    setText(example.text);
    setEnText("");
    setZhText("");
    setMixOpen(example.lang === "bi");
  };

  function cardProps(side: Side, data: DetectOk) {
    return {
      data,
      copied: detector.copied === data.lang,
      onCopy: detector.copy,
      hasBaseline: baseline !== null,
      onSaveBaseline: detector.saveBaseline,
      onRecheck: (index: number, draft: string) => detector.recheck(side, data, index, draft),
      onScan: (index: number) => detector.scan(side, data, index),
      recheckingIndex: detector.rechecking?.side === side ? detector.rechecking.index : null,
      scanProgress: detector.scanProgress,
    };
  }

  return (
    <main className="page">
      <header className="mast">
        <p className="kicker">本机 · 开源模型 · 按段说明</p>
        <h1>作文 AI 写作检测</h1>
        <p className="lede">
          粘贴作文或上传文件，查看模型倾向与逐句定位。正文只在这台电脑上分析。
        </p>
        <div className="examples" role="group" aria-label="体验示例">
          <span>先试试看</span>
          {EXAMPLES.map((example) => (
            <button key={example.id} type="button" disabled={locked} onClick={() => loadExample(example)}>
              {example.label}
            </button>
          ))}
        </div>
        <p className="example-note">示例仅用于体验操作，没有已知的人写或 AI 标签。</p>
      </header>

      <aside className="notice">{DISCLAIMER}</aside>

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
        elapsed={detector.elapsed}
        langReady={langReady}
        readyToSubmit={readyToSubmit}
        onSubmit={onSubmit}
        onCancel={detector.cancel}
      />

      <BatchPanel
        rows={batch.rows}
        running={batch.running}
        openIndex={openIndex}
        onOpen={(index, data) => {
          setOpenIndex(index);
          detector.adopt(data);
        }}
        onCancel={batch.cancel}
      />

      {error && (
        <p className="fail" role="alert">
          {error}
        </p>
      )}

      {baseline && result && !isBilingual(baseline) && !isBilingual(result) && (
        <Compare before={baseline} after={result} />
      )}
      {baseline && result && isBilingual(baseline) && isBilingual(result) && (
        <>
          {baseline.en && result.en && !isSectionErr(baseline.en) && !isSectionErr(result.en) && (
            <Compare before={baseline.en} after={result.en} />
          )}
          {baseline.zh && result.zh && !isSectionErr(baseline.zh) && !isSectionErr(result.zh) && (
            <Compare before={baseline.zh} after={result.zh} />
          )}
        </>
      )}

      {result && !isBilingual(result) && (
        <ResultCard key={openIndex ?? "single"} {...cardProps("single", result)} />
      )}
      {result && isBilingual(result) && (
        <BilingualResult
          data={result}
          render={(side, doc) => <ResultCard {...cardProps(side, doc)} />}
        />
      )}
    </main>
  );
}
