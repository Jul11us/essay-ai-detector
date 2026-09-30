import type { RefObject } from "react";
import type { FilePreview } from "./api";
import { canSubmit, formatElapsed } from "./copy";
import { LANGUAGE_LABEL } from "./languageHint";
import type { Lang, Status } from "./types";

export type InputPanelProps = {
  status: Status | null;
  statusLine: string;
  runtimeNote: string;
  lang: Lang | null;
  setLang: (lang: Lang) => void;
  suggestion: Lang | null;
  text: string;
  setText: (value: string) => void;
  enText: string;
  setEnText: (value: string) => void;
  zhText: string;
  setZhText: (value: string) => void;
  mixOpen: boolean;
  setMixOpen: (open: boolean) => void;
  file: File | null;
  filePreview: FilePreview | null;
  previewBusy: boolean;
  previewError: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File | null) => void;
  forgetResult: () => void;
  busy: boolean;
  /** 单篇检测或批量检测任意一个在跑：输入区整体禁用。 */
  locked: boolean;
  batchFiles: File[];
  onFiles: (files: File[]) => void;
  batchRunning: boolean;
  elapsed: number;
  langReady: boolean;
  readyToSubmit: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

export function InputPanel({
  status,
  statusLine,
  runtimeNote,
  lang,
  setLang,
  suggestion,
  text,
  setText,
  enText,
  setEnText,
  zhText,
  setZhText,
  mixOpen,
  setMixOpen,
  file,
  filePreview,
  previewBusy,
  previewError,
  fileInputRef,
  onFile,
  forgetResult,
  busy,
  locked,
  batchFiles,
  onFiles,
  batchRunning,
  elapsed,
  langReady,
  readyToSubmit,
  onSubmit,
  onCancel,
}: InputPanelProps) {
  const showSuggestion = suggestion && suggestion !== lang;
  const inBatch = batchFiles.length > 0;
  const hasFile = Boolean(file) || inBatch;
  const anyFile = file ?? batchFiles[0] ?? null;
  return (
    <section className="panel">
      <div className="status-row" role="status">
        <span className={`dot ${status?.phase ?? "downloading"}`} />
        {statusLine}
        {runtimeNote && <span className="models">{runtimeNote}</span>}
        {status && (
          <span className="models">
            英文{status.models.en ? "可用" : "未就绪"} · 中文
            {status.models.zh ? "可用" : "未就绪"}
          </span>
        )}
      </div>

      <fieldset className="lang">
        <legend>检测语言</legend>
        <button
          type="button"
          className={lang === "en" ? "chip on" : "chip"}
          disabled={locked}
          onClick={() => setLang("en")}
        >
          英文
        </button>
        <button
          type="button"
          className={lang === "zh" ? "chip on" : "chip"}
          disabled={locked}
          onClick={() => setLang("zh")}
        >
          中文
        </button>
        <button
          type="button"
          className={lang === "bi" ? "chip on" : "chip"}
          disabled={locked}
          onClick={() => {
            setLang("bi");
            // 刚才贴在单栏里的正文会进「自动拆开」。有内容就展开，避免检测时用了一段看不见的旧文本。
            setMixOpen(text.trim().length > 0);
          }}
        >
          中英分开
          <small>摘要 + 正文</small>
        </button>
      </fieldset>
      {showSuggestion && (
        <p className="language-hint">
          输入看起来像{LANGUAGE_LABEL[suggestion]}。
          <button type="button" className="text-btn" disabled={locked} onClick={() => {
            setLang(suggestion);
            if (suggestion === "bi") setMixOpen(true);
          }}>切换为{LANGUAGE_LABEL[suggestion]}</button>
          <span>（仅根据文字脚本提示）</span>
        </p>
      )}

      {lang !== "bi" && (
        <label className="block">
          粘贴正文
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              forgetResult();
            }}
            placeholder="课程作业或学期论文。有文件时以文件为准，忽略此框。"
            rows={12}
            disabled={hasFile || locked}
          />
        </label>
      )}

      {lang === "bi" && (
        <>
          <div className="bi-grid">
            <label className="block">
              英文摘要或参考文献
              <textarea
                value={enText}
                onChange={(e) => {
                  setEnText(e.target.value);
                  forgetResult();
                }}
                placeholder="Abstract、英文标题、英文参考文献。"
                rows={8}
                disabled={hasFile || locked}
              />
            </label>
            <label className="block">
              中文正文
              <textarea
                value={zhText}
                onChange={(e) => {
                  setZhText(e.target.value);
                  forgetResult();
                }}
                placeholder="中文正文。不要和英文摘要混在同一栏。"
                rows={8}
                disabled={hasFile || locked}
              />
            </label>
          </div>
          <details
            className="mix-paste"
            open={mixOpen}
            onToggle={(event) => setMixOpen(event.currentTarget.open)}
          >
            <summary>整篇混在一起，自动拆开</summary>
            <label className="block">
              粘贴正文
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  forgetResult();
                }}
                placeholder="中文段和英文段可以粘在一起，按段落的文字自动拆开。"
                rows={8}
                disabled={hasFile || locked}
              />
            </label>
          </details>
        </>
      )}

      <div className="upload">
        <label className="file">
          上传 .txt / .docx / .pdf（可多选批量检测）
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            disabled={locked}
            onClick={(e) => { e.currentTarget.value = ""; }}
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        {file && (
          <button type="button" className="text-btn" disabled={locked} onClick={() => onFile(null)}>
            清除 {file.name}
          </button>
        )}
      </div>
      {inBatch && (
        <div className="file-preview" role="status">
          <strong>批量检测 · {batchFiles.length} 个文件</strong>
          <ul className="batch-files">
            {batchFiles.map((f, i) => (
              <li key={`${f.name}:${i}`}>{f.name}</li>
            ))}
          </ul>
          <button type="button" className="text-btn" disabled={locked} onClick={() => onFiles([])}>
            清除这 {batchFiles.length} 个文件
          </button>
          <p>
            每个文件单独检测，用同一种语言。逐个排队运行，结束后在下方汇总表里点开任意一篇看逐句结果。
            {lang === "bi" && "批量检测不支持“中英分开”，请改选中文或英文。"}
          </p>
        </div>
      )}
      {file && (
        <div className="file-preview" role="status">
          <strong>文件文字预览 · {file.name}</strong>
          {previewBusy && <p>正在提取文字…</p>}
          {previewError && <p className="fail">{previewError}</p>}
          {filePreview && (
            <>
              <p>{filePreview.char_count} 字符。{filePreview.truncated ? "这里只显示前 5000 字符。" : ""}确认下面是你想检测的正文；文件检测仍使用原文件的段落信息。</p>
              <textarea aria-label="文件提取文字预览" readOnly value={filePreview.text} rows={7} />
            </>
          )}
        </div>
      )}
      <p className="hint">扫描版 PDF 读不出文字，会直接提示你换文字版。</p>

      <button type="button" className="go" disabled={!readyToSubmit} onClick={onSubmit}>
        {batchRunning ? "正在批量检测…" : busy ? "正在检测…" : inBatch ? `批量检测 ${batchFiles.length} 个文件` : "开始检测"}
      </button>
      {busy && (
        <div className="running" role="status">
          <span>已用 {formatElapsed(elapsed)}。长文可能要几十秒。改某一段可以等结果出来后单段重测。</span>
          <button type="button" className="text-btn" onClick={onCancel}>
            取消检测
          </button>
        </div>
      )}
      {!lang && <p className="hint">请先选择中文、英文，或中英分开。</p>}
      {lang && lang !== "bi" && !canSubmit(lang, text, anyFile) && <p className="hint">请粘贴或上传。</p>}
      {lang === "bi" && !canSubmit(lang, text, anyFile, { en: enText, zh: zhText }) && (
        <p className="hint">请填写英文或中文，或上传整篇。</p>
      )}
      {lang === "bi" && !langReady && status?.phase !== "error" && (
        <p className="hint">中英分开需要中文和英文模型都就绪。</p>
      )}
      {lang && lang !== "bi" && !langReady && status?.phase !== "error" && (
        <p className="hint">所选语言的模型还没就绪。</p>
      )}
    </section>
  );
}
