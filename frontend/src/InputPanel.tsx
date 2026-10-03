import { useRef, type RefObject } from "react";
import type { FilePreview } from "./api";
import { canSubmit, formatElapsed } from "./copy";
import { LANGUAGE_LABEL } from "./languageHint";
import type { Lang, Status } from "./types";
import { ScopeSelector } from "./ScopeSelector";

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
  selection?: number[];
  onSelection?: (indices: number[]) => void;
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
  batchSelectionError: string | null;
  batchPending: number;
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
  selection,
  onSelection,
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
  batchSelectionError,
  batchPending,
  elapsed,
  langReady,
  readyToSubmit,
  onSubmit,
  onCancel,
}: InputPanelProps) {
  const restoreDraftFocus = useRef(false);
  const focusRestoredDraft = (node: HTMLTextAreaElement | null) => {
    if (node && restoreDraftFocus.current) {
      restoreDraftFocus.current = false;
      node.focus();
    }
  };
  const showSuggestion = suggestion && suggestion !== lang;
  const inBatch = batchFiles.length > 0;
  const hasFile = Boolean(file) || inBatch;
  const anyFile = file ?? batchFiles[0] ?? null;
  // 与双语接口一致：填写分栏后使用分栏正文，否则使用整篇混合输入。
  const activeText = lang === "bi" && (enText.trim() || zhText.trim()) ? enText + zhText : text;
  const charCount = file ? selection && filePreview?.blocks ? filePreview.blocks.filter((b) => selection.includes(b.index)).reduce((n, b) => n + b.char_count, 0) : filePreview?.char_count : activeText.replace(/\s/g, "").length;
  const uploadButton = <button type="button" className="editor-upload" disabled={locked} onClick={() => fileInputRef.current?.click()}>
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 12V3m-3.5 3.5L10 3l3.5 3.5M4 11v5h12v-5" /></svg>
    {hasFile ? "替换文件" : "上传文件"}
  </button>;
  return (
    <section className="input-panel" aria-labelledby="input-title">
      <div className="manuscript-editor">
        <div className="input-heading">
          <h2 id="input-title">放入你的文字</h2>
          <fieldset className="lang" disabled={inBatch}>
            <legend className="sr-only">检测语言</legend>
            <button
              type="button"
              className={lang === "en" ? "chip on" : "chip"}
              aria-pressed={lang === "en"}
              disabled={locked}
              onClick={() => setLang("en")}
            >
              英文
            </button>
            <button
              type="button"
              className={lang === "zh" ? "chip on" : "chip"}
              aria-pressed={lang === "zh"}
              disabled={locked}
              onClick={() => setLang("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={lang === "bi" ? "chip on" : "chip"}
              aria-pressed={lang === "bi"}
              disabled={locked}
              onClick={() => {
                setLang("bi");
                // 刚才贴在单栏里的正文会进「自动拆开」。有内容就展开，避免检测时用了一段看不见的旧文本。
                setMixOpen(text.trim().length > 0);
              }}
            >
              中英分开
            </button>
          </fieldset>
        </div>

        <div className="editor-canvas">
          <div className="editor-entry">
            {hasFile ? <span>文档导入</span> : lang === "bi" ? <span>中英文分栏</span> : <label htmlFor="manuscript-text">粘贴正文</label>}
            {!hasFile && <span className="entry-or">或</span>}{uploadButton}
            <span className="editor-formats">TXT / DOCX / PDF · 可多选</span>
          </div>
          <input
            ref={fileInputRef}
            className="editor-file-input"
            aria-label="上传 .txt / .docx / .pdf（可多选批量检测）"
            type="file"
            multiple
            accept=".txt,.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            disabled={locked}
            onClick={(e) => { e.currentTarget.value = ""; }}
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
          {showSuggestion && !inBatch && (
            <p className="language-hint">
              输入看起来像{LANGUAGE_LABEL[suggestion]}。
              <button type="button" className="text-btn" disabled={locked} onClick={() => {
                setLang(suggestion);
                if (suggestion === "bi") setMixOpen(true);
              }}>切换为{LANGUAGE_LABEL[suggestion]}</button>
              <span>（仅根据文字脚本提示）</span>
            </p>
          )}

          {lang !== "bi" && !hasFile && (
            <div className="editor-body">
              <textarea
                ref={focusRestoredDraft}
                id="manuscript-text"
                aria-label="粘贴正文"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  forgetResult();
                }}
                placeholder="在这里输入或粘贴需要复核的文字…"
                rows={9}
                disabled={hasFile || locked}
              />
            </div>
          )}

          {lang === "bi" && !hasFile && (
            <>
              <div className="bi-grid">
                <label className="block">
                  英文摘要或参考文献
                  <textarea
                    ref={focusRestoredDraft}
                    id="english-manuscript"
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

          {batchSelectionError && <p className="fail" role="alert">{batchSelectionError}</p>}
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
                每批最多 20 个文件。根据每篇提取的正文自动识别中英文；混合文件分开出分。
                逐个排队运行，可取消后续文件、单独重试失败文件，完成结果会保留。
              </p>
            </div>
          )}
          {file && (
            <div className="file-preview" role="status">
              <div className="file-preview-heading"><strong>文件文字预览 · {file.name}</strong>
                <button type="button" className="text-btn" aria-label={`清除 ${file.name}`} disabled={locked} onClick={() => {
                  restoreDraftFocus.current = true;
                  onFile(null);
                }}>移除文件</button></div>
              {previewBusy && <p>正在提取文字…</p>}
              {previewError && <p className="fail">{previewError}</p>}
          {filePreview && (
            <>
              {onSelection && <ScopeSelector preview={filePreview} selection={selection} locked={locked} onChange={onSelection} />}
                  <p>{filePreview.char_count} 字符。{filePreview.truncated ? "这里只显示前 5000 字符。" : ""}确认下面是你想检测的正文；文件检测仍使用原文件的段落信息。</p>
                  <textarea aria-label="文件提取文字预览" readOnly value={filePreview.text} rows={7} />
                </>
              )}
            </div>
          )}
        </div>

        <div className="editor-footer">
          <div className="input-meta">
            <span>{inBatch ? `${batchFiles.length} 个文件 · 自动识别语言` : charCount === undefined ? previewBusy ? "正在提取文字…" : "暂无文字预览" : `${charCount.toLocaleString()} 字符`}</span>
            <span>{hasFile ? "检测使用文件中的正文" : "保留段落 · 逐句复核"}</span>
          </div>
          <button type="button" className="go" disabled={!readyToSubmit} onClick={onSubmit}>
            {(busy || batchRunning) && <span className="button-spinner" aria-hidden="true" />}
            {batchRunning ? "正在批量检测…" : busy ? "正在检测…" : inBatch
              ? batchPending === batchFiles.length ? `批量检测 ${batchFiles.length} 个文件`
                : batchPending > 0 ? `继续检测 ${batchPending} 个未完成文件` : "这批文件已全部完成"
              : "开始检测"}<span className="go-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <div className="input-support">
        <div className="status-row" role="status">
          <span className={`dot ${status?.phase ?? "downloading"}`} />
          <span className={status?.phase === "ready" ? "sr-only" : undefined}>{statusLine}</span>
          {status && <span className="models">英文{status.models.en ? "可用" : "未就绪"} · 中文{status.models.zh ? "可用" : "未就绪"}</span>}
          {runtimeNote && <span className="runtime-note">{runtimeNote}</span>}
        </div>
        <details className="upload-help"><summary>上传说明</summary><p>支持 TXT、Word（.docx）和文字版 PDF。可多选，每批最多 20 个文件。扫描版 PDF 读不出文字，会直接提示你换文字版。</p></details>
      </div>
      {busy && (
        <div className="running" role="status">
          <span>已用 {formatElapsed(elapsed)}。长文可能要几十秒。改某一段可以等结果出来后单段重测。</span>
          <button type="button" className="text-btn" onClick={onCancel}>
            取消检测
          </button>
        </div>
      )}
      {!lang && !inBatch && <p className="hint input-readiness">选择检测语言，粘贴正文或上传文件后即可开始。</p>}
      {lang && lang !== "bi" && !canSubmit(lang, text, anyFile) && <p className="hint">请粘贴或上传。</p>}
      {lang === "bi" && !canSubmit(lang, text, anyFile, { en: enText, zh: zhText }) && (
        <p className="hint">请填写英文或中文，或上传整篇。</p>
      )}
      {lang === "bi" && !inBatch && !langReady && status?.phase !== "error" && (
        <p className="hint">中英分开需要中文和英文模型都就绪。</p>
      )}
      {lang && lang !== "bi" && !inBatch && !langReady && status?.phase !== "error" && (
        <p className="hint">所选语言的模型还没就绪。</p>
      )}
      {inBatch && !status?.models.en && !status?.models.zh && <p className="hint">请等待检测模型就绪。</p>}
    </section>
  );
}
