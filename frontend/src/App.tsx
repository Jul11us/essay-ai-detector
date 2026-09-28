import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  deferUnscanned,
  paragraphsToScan,
  carrySentences,
  mapParagraph,
  replaceParagraph,
  type Outcome,
  type Side,
} from "./aggregate";
import {
  detect,
  detectSentences,
  fetchExplain,
  fetchStatus,
  previewFile,
  isDetectErr,
  type FilePreview,
  type SentenceScan,
} from "./api";
import { canSubmit, formatElapsed, formatResult } from "./copy";
import { EXAMPLES } from "./examples";
import { LANGUAGE_LABEL, suggestLanguage } from "./languageHint";
import { Compare, ResultCard } from "./ResultView";
import { buildBilingualReport, downloadReport, printReport } from "./report";
import type { BilingualOk, DetectOk, Lang, Status } from "./types";
import { isBilingual, isSectionErr } from "./types";

const DISCLAIMER =
  "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。英文检测使用本机 Vanguard，不是知网或 Turnitin。";

// 兜底：正常长文几十秒就结束，十分钟还没回来说明后端卡住了，
// 别让按钮永远显示「正在检测」而没有出路。主要出路是用户自己点取消。
const DETECT_TIMEOUT_MS = 10 * 60 * 1000;

// 模型加载期间的状态轮询间隔。
const STATUS_POLL_MS = 2000;

const SCAN_FAILED = "逐句打分失败，可以再点一次。";

/**
 * 把一段的逐句结果写回去。只在这一段的正文还是发请求时那份时才写：
 * 整篇逐句打分要跑一阵，期间学生可能已经改了某段并重测，序号对上但内容已换。
 */
function applyScan(
  cur: Outcome | null,
  side: Side,
  index: number,
  sentText: string,
  data: SentenceScan | { error: string; message: string } | string,
): Outcome | null {
  if (!cur) return cur;
  return mapParagraph(cur, side, index, (p) => {
    if ((p.text || p.excerpt) !== sentText) return p;
    if (typeof data === "string") return { ...p, sentences: [], sentenceNote: data };
    if (isDetectErr(data)) return { ...p, sentences: [], sentenceNote: data.message };
    return { ...p, sentences: data.sentences, sentenceNote: data.note || undefined };
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default function App() {
  const [lang, setLang] = useState<Lang | null>(null);
  const [text, setText] = useState("");
  const [enText, setEnText] = useState("");
  const [zhText, setZhText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Outcome | null>(null);
  const [baseline, setBaseline] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanToken, setScanToken] = useState(0);
  const [rechecking, setRechecking] = useState<{ side: Side; index: number } | null>(null);
  const [mixOpen, setMixOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const cancelReason = useRef<"user" | "timeout" | null>(null);
  const gen = useRef(0);
  const scanEpoch = useRef(0);
  // 自动逐句定位的请求。新检测开始时要掐掉：后端看到断开才会让出推理闸门。
  const scanAbort = useRef<AbortController | null>(null);

  // 只在后端还在加载模型时轮询。`loading` 一变成 false，`models` 就是最终结果
  // （中英文都就绪，或某个确实失败了），再每 2 秒问下去没有意义。
  // 连不上后端时保持重试——那通常只是服务还没启动。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const pull = async () => {
      let next: Status;
      let unreachable = false;
      try {
        next = await fetchStatus();
      } catch {
        unreachable = true;
        next = {
          phase: "error",
          detail: "无法连接检测服务，请确认后端已在 8000 端口启动。",
          models: { zh: false, en: false },
          loading: false,
        };
      }
      if (cancelled) return;
      setStatus(next);
      if (unreachable || next.loading) {
        timer = window.setTimeout(pull, STATUS_POLL_MS);
      }
    };

    pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 检测期间每秒走一次，让「正在检测」不是一句静止的话。
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // 分数先返回。整篇逐句打分另起请求，一段一个，分数高的段先跑，边跑边上色。
  useEffect(() => {
    const snapshot = result;
    const epoch = scanToken;
    if (!epoch || !snapshot || scanEpoch.current !== epoch) return;
    let cancelled = false;
    const jobs: { side: Side; lang: "zh" | "en"; index: number; text: string; score: number }[] = [];
    const collect = (doc: DetectOk, side: Side) => {
      for (const para of paragraphsToScan(doc)) {
        jobs.push({
          side,
          lang: doc.lang,
          index: para.index,
          text: para.text || "",
          score: para.score,
        });
      }
    };
    if (isBilingual(snapshot)) {
      if (snapshot.en && !isSectionErr(snapshot.en)) collect(snapshot.en, "en");
      if (snapshot.zh && !isSectionErr(snapshot.zh)) collect(snapshot.zh, "zh");
    } else {
      collect(snapshot, "single");
    }
    if (!jobs.length) return;
    jobs.sort((a, b) => b.score - a.score);
    const ctrl = new AbortController();
    scanAbort.current = ctrl;

    const run = async () => {
      let done = 0;
      setScanProgress({ done, total: jobs.length });
      for (const job of jobs) {
        if (cancelled || scanEpoch.current !== epoch) return;
        let data: SentenceScan | { error: string; message: string } | string;
        try {
          data = await detectSentences({ lang: job.lang, text: job.text }, ctrl.signal);
        } catch {
          data = SCAN_FAILED;
        }
        if (cancelled || scanEpoch.current !== epoch) return;
        setResult((cur) => applyScan(cur, job.side, job.index, job.text, data));
        done += 1;
        setScanProgress({ done, total: jobs.length });
      }
      if (!cancelled && scanEpoch.current === epoch) {
        setResult((cur) => (cur ? deferUnscanned(cur) : cur));
        setScanProgress(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
      ctrl.abort();
      if (scanAbort.current === ctrl) scanAbort.current = null;
      setScanProgress(null);
    };
  }, [scanToken]);

  const langReady =
    lang === "bi"
      ? Boolean(status?.models.zh && status?.models.en)
      : lang
        ? Boolean(status?.models[lang])
        : false;
  const readyToSubmit =
    canSubmit(lang, text, file, { en: enText, zh: zhText }) && langReady && !busy &&
    (!file || (filePreview !== null && !previewBusy && !previewError));
  const statusLine = status?.detail ?? "正在连接检测服务…";
  const runtimeNote = [
    status?.runtime?.en === "onnx-int8" ? "英文 INT8" : "",
    status?.runtime?.zh === "onnx-int8" ? "中文 INT8" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const suggestion = suggestLanguage(file ? filePreview?.text ?? "" : [text, enText, zhText].join("\n"));
  const showSuggestion = suggestion && suggestion !== lang;

  const onFile = (next: File | null) => {
    previewAbort.current?.abort();
    setFile(next);
    setBaseline(null);
    scanEpoch.current = 0;
    scanAbort.current?.abort();
    setFilePreview(null);
    setPreviewError(null);
    setResult(null);
    setError(null);
    if (!next) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPreviewBusy(false);
      return;
    }
    const ctrl = new AbortController();
    previewAbort.current = ctrl;
    setPreviewBusy(true);
    void previewFile(next, ctrl.signal)
      .then((data) => {
        if (previewAbort.current !== ctrl) return;
        if (isDetectErr(data)) setPreviewError(data.message);
        else setFilePreview(data);
      })
      .catch(() => {
        if (previewAbort.current === ctrl) setPreviewError("文件预览失败，请重新上传。");
      })
      .finally(() => {
        if (previewAbort.current === ctrl) setPreviewBusy(false);
      });
  };

  const useExample = (example: (typeof EXAMPLES)[number]) => {
    onFile(null);
    setLang(example.lang);
    setText(example.text);
    setEnText("");
    setZhText("");
    setMixOpen(example.lang === "bi");
    setBaseline(null);
    setResult(null);
    setError(null);
  };

  function forgetResult() {
    setResult(null);
    setCopied(null);
  }

  async function onSubmit() {
    if (!lang || !canSubmit(lang, text, file, { en: enText, zh: zhText })) {
      setError("请粘贴或上传，并先选择语言。");
      return;
    }
    const mine = ++gen.current;
    scanEpoch.current = 0;
    scanAbort.current?.abort();
    scanAbort.current = null;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    cancelReason.current = null;
    setElapsed(0);
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(null);
    const timer = window.setTimeout(() => {
      cancelReason.current = "timeout";
      ctrl.abort();
    }, DETECT_TIMEOUT_MS);
    try {
      const data = await detect(
        { lang, text, file, en: enText, zh: zhText },
        ctrl.signal,
      );
      if (mine !== gen.current) return;
      if (isDetectErr(data)) {
        setError(data.message);
      } else {
        setResult(data);
        scanEpoch.current = mine;
        setScanToken(mine);
      }
    } catch {
      if (mine !== gen.current) return;
      if (cancelReason.current === "timeout") {
        setError("检测超过 10 分钟已自动取消。文本过长时请拆成多篇再测。");
      } else if (cancelReason.current === "user") {
        setError("已取消检测。");
      } else {
        setError("本机推理失败，未生成分数。");
      }
    } finally {
      window.clearTimeout(timer);
      abortRef.current = null;
      cancelReason.current = null;
      if (mine === gen.current) setBusy(false);
    }
  }

  function onCancel() {
    cancelReason.current = "user";
    abortRef.current?.abort();
  }

  async function onCopy(current: DetectOk) {
    await navigator.clipboard.writeText(formatResult(current));
    setCopied(current.lang);
    window.setTimeout(() => setCopied(null), 1600);
  }

  async function onRecheck(side: Side, doc: DetectOk, index: number, draft: string) {
    const mine = gen.current;
    setRechecking({ side, index });
    try {
      const data = await detect({
        lang: doc.lang,
        text: draft,
        file: null,
        scope: "paragraph",
      });
      if (mine !== gen.current) return "已经开始了新的检测。";
      if (isDetectErr(data) || isBilingual(data)) {
        return isDetectErr(data) ? data.message : "这一段没有返回分数。";
      }
      let next = replaceParagraph(doc, index, data);
      try {
        const explained = await fetchExplain({
          lang: doc.lang,
          text: next.paragraphs.map((p) => p.text || p.excerpt).join("\n\n"),
        });
        if (!isDetectErr(explained)) {
          next = { ...next, markers: explained.markers, rhythm: explained.rhythm };
        }
      } catch {
        // 分数已经按这一段更新，特征词暂时留着上一次的。
      }
      if (mine !== gen.current) return "已经开始了新的检测。";
      const merged = next;
      setResult((cur) => {
        if (!cur) return cur;
        // 重测期间整篇逐句打分还在跑，其它段可能刚拿到句子分数；别用发请求时的旧快照盖掉。
        if (side === "single" && !isBilingual(cur)) return carrySentences(cur, merged);
        const part = isBilingual(cur) && side !== "single" ? cur[side] : null;
        if (part && !isSectionErr(part)) return { ...cur, [side]: carrySentences(part, merged) };
        return cur;
      });
      // 改过的这一段自动重新逐句打分，不用再点「定位」。
      const fresh = data.paragraphs.map((_, k) => index + k);
      void (async () => {
        for (const i of fresh) await onScan(side, merged, i);
      })();
      return null;
    } catch {
      return "本机推理失败，这一段没有重测。";
    } finally {
      setRechecking(null);
    }
  }

  async function onScan(side: Side, doc: DetectOk, index: number) {
    const para = doc.paragraphs.find((p) => p.index === index);
    const body = para?.text || para?.excerpt;
    if (!body) return;
    const mine = gen.current;
    // 先清掉旧结果和「定位」按钮，表示这一段正在跑。
    setResult((cur) =>
      cur
        ? mapParagraph(cur, side, index, (p) =>
            (p.text || p.excerpt) === body
              ? { ...p, sentences: undefined, sentenceNote: "正在逐句打分…" }
              : p,
          )
        : cur,
    );
    let data: SentenceScan | { error: string; message: string } | string;
    try {
      data = await detectSentences({ lang: doc.lang, text: body });
    } catch {
      data = SCAN_FAILED;
    }
    if (mine !== gen.current) return;
    setResult((cur) => applyScan(cur, side, index, body, data));
  }

  function cardProps(side: Side, data: DetectOk) {
    return {
      data,
      copied: copied === data.lang,
      onCopy,
      hasBaseline: baseline !== null,
      onSaveBaseline: () => {
        if (result && isBilingual(result)) setBaseline(clone(result));
        else setBaseline(clone(data));
      },
      onRecheck: (index: number, draft: string) => onRecheck(side, data, index, draft),
      onScan: (index: number) => onScan(side, data, index),
      recheckingIndex: rechecking?.side === side ? rechecking.index : null,
      scanProgress,
    };
  }

  return (
    <div className="page">
      <header className="mast">
        <p className="kicker">本机 · 开源模型 · 按段说明</p>
        <h1>作文 AI 写作检测</h1>
        <p className="lede">
          粘贴作文或上传文件，查看模型倾向与逐句定位。正文只在这台电脑上分析。
        </p>
        <div className="examples" aria-label="体验示例">
          <span>先试试看</span>
          {EXAMPLES.map((example) => (
            <button key={example.id} type="button" disabled={busy} onClick={() => useExample(example)}>
              {example.label}
            </button>
          ))}
        </div>
        <p className="example-note">示例仅用于体验操作，没有已知的人写或 AI 标签。</p>
      </header>

      <aside className="notice">{DISCLAIMER}</aside>

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
            disabled={busy}
            onClick={() => setLang("en")}
          >
            英文
            <small>Vanguard</small>
          </button>
          <button
            type="button"
            className={lang === "zh" ? "chip on" : "chip"}
            disabled={busy}
            onClick={() => setLang("zh")}
          >
            中文
            <small>{status?.models.zh ? "zhv3" : "需另载模型"}</small>
          </button>
          <button
            type="button"
            className={lang === "bi" ? "chip on" : "chip"}
            disabled={busy}
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
            <button type="button" className="text-btn" disabled={busy} onClick={() => {
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
              disabled={Boolean(file) || busy}
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
                  disabled={Boolean(file) || busy}
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
                  disabled={Boolean(file) || busy}
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
                  disabled={Boolean(file) || busy}
                />
              </label>
            </details>
          </>
        )}

        <div className="upload">
          <label className="file">
            上传 .txt / .docx / .pdf
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              disabled={busy}
              onClick={(e) => { e.currentTarget.value = ""; }}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {file && (
            <button type="button" className="text-btn" disabled={busy} onClick={() => onFile(null)}>
              清除 {file.name}
            </button>
          )}
        </div>
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
          {busy ? "正在检测…" : "开始检测"}
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
        {lang && lang !== "bi" && !canSubmit(lang, text, file) && <p className="hint">请粘贴或上传。</p>}
        {lang === "bi" && !canSubmit(lang, text, file, { en: enText, zh: zhText }) && (
          <p className="hint">请填写英文或中文，或上传整篇。</p>
        )}
        {lang === "bi" && !langReady && status?.phase !== "error" && (
          <p className="hint">中英分开需要中文和英文模型都就绪。</p>
        )}
        {lang && lang !== "bi" && !langReady && status?.phase !== "error" && (
          <p className="hint">所选语言的模型还没就绪。</p>
        )}
      </section>

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

      {result && !isBilingual(result) && <ResultCard {...cardProps("single", result)} />}
      {result && isBilingual(result) && (
        <BilingualResult
          data={result}
          render={(side, doc) => <ResultCard {...cardProps(side, doc)} />}
        />
      )}
    </div>
  );
}

function BilingualResult({
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
