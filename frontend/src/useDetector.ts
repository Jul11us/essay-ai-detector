import { useEffect, useRef, useState } from "react";
import {
  deferUnscanned,
  paragraphsToScan,
  carrySentences,
  mapParagraph,
  replaceParagraph,
  type Outcome,
  type Side,
} from "./aggregate";
import { detect, detectSentences, fetchExplain, isDetectErr, type SentenceScan } from "./api";
import { canSubmit, formatResult } from "./copy";
import type { DetectOk, Lang, SentenceReview } from "./types";
import { keepReviews } from "./reviews";
import { recordReview } from "./writingProcess";
import { appendVersion, ensureVersions, recordRecheck } from "./versions";
import { isBilingual, isSectionErr } from "./types";

// 兜底：正常长文几十秒就结束，十分钟还没回来说明后端卡住了，
// 别让按钮永远显示「正在检测」而没有出路。主要出路是用户自己点取消。
const DETECT_TIMEOUT_MS = 10 * 60 * 1000;

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
    return {
      ...p,
      sentences: keepReviews(p.sentences || [], data.sentences),
      sentenceNote: data.note || undefined,
    };
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type DetectInput = {
  selection?: number[];
  source_sha256?: string;
  lang: Lang | null;
  text: string;
  file: File | null;
  en: string;
  zh: string;
};

/**
 * 整篇检测、逐句定位、单段重测的状态机。
 *
 * `gen` 是检测代数：新检测开始后，旧请求回来的结果一律丢掉。
 * `scanEpoch` 是逐句打分的代数：置 0 表示当前没有要跑的逐句任务。
 */
export function useDetector() {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Outcome | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanToken, setScanToken] = useState(0);
  const [rechecking, setRechecking] = useState<{ side: Side; index: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelReason = useRef<"user" | "timeout" | null>(null);
  const gen = useRef(0);
  const scanEpoch = useRef(0);
  // 自动逐句定位的请求。新检测开始时要掐掉：后端看到断开才会让出推理闸门。
  const scanAbort = useRef<AbortController | null>(null);

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
    const jobs: { side: Side; lang: "zh" | "en"; index: number; text: string; score: number }[] =
      [];
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
    // 只在 scanToken 变化时开跑：result 是那一刻的快照，之后的更新由 applyScan 写回。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanToken]);

  /** 输入变了：清空当前结果，掐掉还在跑的逐句任务。任务记录保留版本历史。 */
  function reset() {
    scanEpoch.current = 0;
    scanAbort.current?.abort();
    setResult(null);
    setError(null);
  }

  /** 把已经算好的一份结果（批量检测里的某个文件）接进来，之后和单篇检测一样可以逐句定位、重测、导出。 */
  function adopt(data: Outcome) {
    const mine = ++gen.current;
    scanAbort.current?.abort();

    setError(null);
    setCopied(null);
    setResult(ensureVersions(data, "已存结果 · 历史起点"));
    scanEpoch.current = mine;
    setScanToken(mine);
  }

  /** 改了输入正文：清掉当前结果，已有任务和版本仍在任务中心。 */
  function forgetResult() {
    setResult(null);
    setCopied(null);
  }

  async function submit(input: DetectInput) {
    const { lang, text, file, en: enText, zh: zhText } = input;
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
        {
          lang,
          text,
          file,
          en: enText,
          zh: zhText,
          selection: input.selection,
          source_sha256: input.source_sha256,
        },
        ctrl.signal,
      );
      if (mine !== gen.current) return;
      if (isDetectErr(data)) {
        setError(data.message);
      } else {
        setResult(ensureVersions(data));
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

  function cancel() {
    cancelReason.current = "user";
    abortRef.current?.abort();
  }

  async function copy(current: DetectOk) {
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
      if (
        data.model_id !== doc.model_id ||
        (doc.model_revision && data.model_revision && doc.model_revision !== data.model_revision)
      )
        return "检测模型版本已变化，请重新检测整篇，再继续修改与对比。当前结果已保留。";
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
        if (side === "single" && !isBilingual(cur))
          return recordRecheck(cur, carrySentences(cur, merged), `第 ${index + 1} 段重测`);
        const part = isBilingual(cur) && side !== "single" ? cur[side] : null;
        if (part && !isSectionErr(part))
          return recordRecheck(
            cur,
            {
              ...cur,
              [side]: carrySentences(part, merged),
              detection_scope: merged.detection_scope ?? cur.detection_scope,
            },
            `${side === "en" ? "英文" : "中文"}第 ${index + 1} 段重测`,
          );
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

  function saveVersion(label = "手动保存") {
    setResult((cur) =>
      cur
        ? appendVersion(
            ensureVersions(cur),
            label.trim().slice(0, 80) || "手动保存",
            "manual",
            true,
          )
        : cur,
    );
  }
  function restoreVersion(id: string) {
    ++gen.current;
    scanEpoch.current = 0;
    scanAbort.current?.abort();
    setScanProgress(null);
    setResult((cur) => {
      const version = cur?.version_history?.find((entry) => entry.id === id);
      if (!cur || !version) return cur;
      const saved = appendVersion(cur, "恢复前的复核记录", "manual", false, "checkpoint");
      const restored = deferUnscanned(clone(version.result));
      return appendVersion(
        {
          ...restored,
          version_history: saved.version_history,
          writing_process: saved.writing_process,
        },
        `恢复自 ${version.label}`,
        "restore",
        true,
      );
    });
  }

  function reviewSentence(
    side: Side,
    paraIndex: number,
    sentenceIndex: number,
    expectedText: string,
    review: SentenceReview | null,
  ) {
    setResult((cur) =>
      cur
        ? recordReview(
            cur,
            mapParagraph(cur, side, paraIndex, (para) => {
              if (para.sentences?.[sentenceIndex]?.text !== expectedText) return para;
              return {
                ...para,
                sentences: para.sentences.map((sentence, i) =>
                  i === sentenceIndex ? { ...sentence, review: review ?? undefined } : sentence,
                ),
              };
            }),
            side,
            paraIndex,
            sentenceIndex,
            expectedText,
            review,
          )
        : cur,
    );
  }

  return {
    busy,
    elapsed,
    result,

    error,
    copied,
    scanProgress,
    rechecking,
    setError,
    reset,
    adopt,
    forgetResult,
    submit,
    cancel,
    copy,
    recheck: onRecheck,
    scan: onScan,

    saveVersion,
    restoreVersion,
    reviewSentence,
  };
}
