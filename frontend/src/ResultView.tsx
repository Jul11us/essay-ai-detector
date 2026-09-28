import { useEffect, useState } from "react";
import { MarkerPanel, RhythmChart, ScoreBars } from "./Insights";
import { sameScores, suspectKey, topSuspects, type Suspect } from "./aggregate";
import { composition, spanPlace, unitPlace, type Composition, type Unit } from "./composition";
import {
  CONF_LABEL,
  SHORT_PARAGRAPH_CHARS,
  VERDICT_LABEL,
  formatPercent,
  isShortParagraph,
} from "./copy";
import { buildReportHtml, downloadReport, printReport } from "./report";
import type { DetectOk, ParagraphHit } from "./types";

export function sentenceDomId(lang: string, paraIndex: number, sentIndex: number): string {
  return `sent-${lang}-${paraIndex}-${sentIndex}`;
}

export function paraDomId(lang: string, paraIndex: number): string {
  return `para-${lang}-${paraIndex}`;
}

/** 滚到原文某处并闪一下。过短的段收在折叠里，先展开。 */
function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const fold = el.closest("details");
  if (fold && !fold.open) fold.open = true;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  if (el instanceof HTMLButtonElement) el.click();
  el.classList.remove("flash");
  // 强制回流，让同一处连点两次也能重新闪一下。
  void el.offsetWidth;
  el.classList.add("flash");
}

function unitDomId(lang: string, u: Unit): string {
  return u.sentIndex === null ? paraDomId(lang, u.paraIndex) : sentenceDomId(lang, u.paraIndex, u.sentIndex);
}

const BAND_LABEL = { ai: "较高分", unclear: "不确定", human: "较低分" } as const;

function CompositionPanel({ lang, comp }: { lang: string; comp: Composition }) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const basisNote = {
    sentences: "按每一句的分数、以字数加权统计。",
    partial: "逐句打分还没跑完，没打完的段先按整段分数计，打完会自动更新。",
    paragraphs: "逐句打分还没开始，暂按各段分数估计，打完会自动更新。",
  }[comp.basis];
  return (
    <div className={`compo ${comp.verdict}`}>
      <p className="compo-kicker">全文分布 · 按模型档位</p>
      <p className="compo-label">{comp.label}</p>
      <div className="compo-strip" role="list" aria-label="全文分布，按原文顺序">
        {comp.units.map((u) => (
          <button
            key={`${u.paraIndex}:${u.sentIndex ?? "p"}`}
            type="button"
            role="listitem"
            className={`seg ${u.band}`}
            style={{ flexGrow: u.weight }}
            title={`${unitPlace(u)} · ${formatPercent(u.score)}%${u.borrowed ? "（段分数）" : ""}`}
            aria-label={`${unitPlace(u)}，${BAND_LABEL[u.band]}`}
            onClick={() => jumpTo(unitDomId(lang, u))}
          />
        ))}
      </div>
      <p className="compo-legend">
        <span className="key ai" />较高分 {pct(comp.ai)}
        <span className="key unclear" />不确定 {pct(comp.unclear)}
        <span className="key human" />较低分 {pct(comp.human)}
      </p>
      <p className="compo-detail">{comp.detail}</p>
      <p className="fine">{basisNote} 色条从左到右就是原文顺序，点一格跳到那一句。</p>
      {comp.spans.length > 0 && (
        <div className="compo-spans">
          <h2>连续较高分的区段</h2>
          <ol>
            {comp.spans.map((span) => (
              <li key={unitDomId(lang, span.first)}>
                <button type="button" className="suspect-row" onClick={() => jumpTo(unitDomId(lang, span.first))}>
                  <span className="suspect-score">{pct(span.share)}</span>
                  <span className="suspect-where">{spanPlace(span)}</span>
                  <span className="suspect-text">
                    {span.first.text}
                    {span.first !== span.last ? " …" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="fine">左边是这一段区段占全文字数的比例。区段之间隔着较低分的句子。</p>
        </div>
      )}
    </div>
  );
}

function sentenceClass(highlight: string | null, top: boolean): string | undefined {
  if (top) return "sent top";
  return highlight ? `sent ${highlight}` : undefined;
}

function ParagraphBody({
  para,
  lang,
  topKeys,
}: {
  para: ParagraphHit;
  lang: string;
  topKeys: Set<string>;
}) {
  // 保留原下标：「嫌疑最重」按 sentences 数组里的位置记，过滤掉空句会错位。
  const [selected, setSelected] = useState<number | null>(null);
  const sentences = (para.sentences ?? [])
    .map((sentence, index) => ({ sentence, index }))
    .filter(({ sentence }) => sentence.text);
  if (!sentences.length) {
    return <p className="body">{para.text || para.excerpt}</p>;
  }
  const selectedSentence = selected === null ? null : para.sentences?.[selected] ?? null;
  return (
    <div>
      <p className="body">
        {sentences.map(({ sentence, index }, order) => {
          const top = topKeys.has(suspectKey(para.index, index));
          const content = sentence.score == null ? (
            <span id={sentenceDomId(lang, para.index, index)}>{sentence.text}</span>
          ) : (
            <button
              type="button"
              id={sentenceDomId(lang, para.index, index)}
              className={`sent-button ${sentenceClass(sentence.highlight, top) || "sent"}`}
              title={`查看本句模型分数：${formatPercent(sentence.score)}%`}
              aria-label={`第 ${para.index + 1} 段第 ${index + 1} 句，模型分数 ${formatPercent(sentence.score)}%，点击查看说明`}
              onClick={() => setSelected(index)}
            >
              {sentence.text}
            </button>
          );
          return <span key={index}>{order > 0 ? " " : ""}{content}</span>;
        })}
      </p>
      {selectedSentence?.score != null && (
        <div className="sentence-detail" role="status">
          <strong>第 {para.index + 1} 段第 {selected! + 1} 句 · 模型分数 {formatPercent(selectedSentence.score)}%</strong>
          <p>单句与相邻句上下文各检测一次，取两者较低分。请连同前后句阅读。</p>
          {selectedSentence.observations?.length
            ? <p>可观察的套话：{selectedSentence.observations.map((item) => item.phrase).join("、")}。这不是分数的因果解释，也不是 AI 写作证据。</p>
            : <p>本句未命中本站的套话清单；这不能解释分数高低。</p>}
        </div>
      )}
    </div>
  );
}

function SuspectList({ lang, suspects }: { lang: string; suspects: Suspect[] }) {
  if (!suspects.length) return null;
  const jump = (s: Suspect) => jumpTo(sentenceDomId(lang, s.paraIndex, s.sentIndex));
  return (
    <div className="suspects">
      <h2>优先复核的句子</h2>
      <p className="fine">
        全文单句分数最高的 {suspects.length} 句，点一句定位原文。分数不是生成证据。
      </p>
      <ol>
        {suspects.map((s) => (
          <li key={suspectKey(s.paraIndex, s.sentIndex)}>
            <button type="button" className="suspect-row" onClick={() => jump(s)}>
              <span className="suspect-score">{formatPercent(s.score)}%</span>
              <span className="suspect-where">第 {s.paraIndex + 1} 段</span>
              <span className="suspect-text">{s.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Para({
  para,
  lang,
  topKeys,
  locked,
  rechecking,
  onRecheck,
  onScan,
}: {
  para: ParagraphHit;
  lang: string;
  topKeys: Set<string>;
  locked: boolean;
  rechecking: boolean;
  onRecheck: (index: number, text: string) => Promise<string | null>;
  onScan: (index: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(para.text || para.excerpt);
  const [localError, setLocalError] = useState<string | null>(null);
  const located = (para.sentences ?? []).some((s) => s.score != null);
  // undefined 表示还在排队或正在跑；null / [] 是被跳过或失败了，给个按钮手动再来。
  const canLocate = !located && para.sentences !== undefined;

  useEffect(() => {
    setDraft(para.text || para.excerpt);
  }, [para.text, para.excerpt, para.score]);

  async function submit() {
    setLocalError(null);
    const message = await onRecheck(para.index, draft);
    if (message) {
      setLocalError(message);
      return;
    }
    setEditing(false);
  }

  return (
    <li id={paraDomId(lang, para.index)} className={`para ${para.verdict}`}>
      <header>
        <span>第 {para.index + 1} 段</span>
        <strong>
          {formatPercent(para.score)}% · {VERDICT_LABEL[para.verdict]}
        </strong>
      </header>
      {editing ? (
        <textarea
          className="para-edit"
          value={draft}
          aria-label={`修改第 ${para.index + 1} 段`}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
        />
      ) : (
        <ParagraphBody para={para} lang={lang} topKeys={topKeys} />
      )}
      {para.sentenceNote && <p className="fine">{para.sentenceNote}</p>}
      <div className="para-actions">
        {editing ? (
          <>
            <button type="button" className="text-btn" disabled={locked || rechecking} onClick={submit}>
              {rechecking ? "正在重测这一段…" : "重测这一段"}
            </button>
            <button
              type="button"
              className="text-btn"
              disabled={rechecking}
              onClick={() => {
                setDraft(para.text || para.excerpt);
                setEditing(false);
                setLocalError(null);
              }}
            >
              取消修改
            </button>
          </>
        ) : (
          <button
            type="button"
            className="text-btn"
            disabled={locked || rechecking}
            onClick={() => setEditing(true)}
          >
            在此修改并重测本段
          </button>
        )}
        {canLocate && (
          <button
            type="button"
            className="text-btn"
            disabled={locked || rechecking}
            onClick={() => onScan(para.index)}
          >
            定位本段句子
          </button>
        )}
      </div>
      {localError && <p className="fail">{localError}</p>}
    </li>
  );
}

export function ResultCard({
  data,
  copied,
  onCopy,
  hasBaseline,
  onSaveBaseline,
  onRecheck,
  onScan,
  recheckingIndex,
  scanProgress,
}: {
  data: DetectOk;
  copied: boolean;
  onCopy: (data: DetectOk) => void;
  hasBaseline: boolean;
  onSaveBaseline: (data: DetectOk) => void;
  onRecheck: (index: number, text: string) => Promise<string | null>;
  onScan: (index: number) => Promise<void>;
  recheckingIndex: number | null;
  scanProgress: { done: number; total: number } | null;
}) {
  const percent = formatPercent(data.score);
  const shortParas = data.paragraphs.filter(isShortParagraph);
  const mainParas = data.paragraphs.filter((p) => !isShortParagraph(p));
  const collapseShort = mainParas.length > 0 && shortParas.length > 0;
  const listed = collapseShort ? mainParas : data.paragraphs;
  const collapsed = collapseShort ? shortParas : [];
  const highlighted = data.paragraphs.some((p) => p.sentences?.some((s) => s.highlight));
  const suspects = topSuspects(data);
  const comp = composition(data);
  const topKeys = new Set(suspects.map((s) => suspectKey(s.paraIndex, s.sentIndex)));

  const headline = {
    low: "模型倾向较低",
    uncertain: "模型暂时无法明确判断",
    high: "模型倾向较高",
  }[data.verdict];

  return (
    <section className="result" aria-live="polite">
      <div className="result-heading">
        <div>
          <p className="result-kicker">检测结果 · {data.lang === "zh" ? "中文" : "英文"}</p>
          <h2>{headline}</h2>
          <p className="result-lead">{data.confidence === "low"
            ? "文本偏短或只有一个段落，单个高分还不足以给出明确结论。请查看原句和上下文。"
            : "请先看标记的原句和上下文。单个分数不能证明文字来源。"}</p>
          {data.mixed_variance && <p className="mix">各段差异较大，建议逐段查看。</p>}
        </div>
        <div className="result-score" aria-label={`模型原始分数 ${percent}%`}>
          <span>模型原始分数</span>
          <strong>{percent}%</strong>
          <small>未经过本站作文样本校准，不是 AI 所写字数比例</small>
        </div>
      </div>
      <div className="result-actions">
        <button type="button" className="text-btn" onClick={() => onCopy(data)}>
          {copied ? "已复制" : "复制结果"}
        </button>
        <button type="button" className="text-btn" onClick={() => downloadReport(buildReportHtml(data), "ai-rate-report.html")}>
          导出 HTML 报告
        </button>
        <button type="button" className="text-btn" onClick={() => printReport(buildReportHtml(data))}>
          打印报告
        </button>
        <button type="button" className="text-btn" onClick={() => onSaveBaseline(data)}>
          {hasBaseline ? "用现在这份覆盖初稿" : "记下这份为初稿"}
        </button>
      </div>
      <div className="result-layout">
        <div className="manuscript">
          <div className="manuscript-heading">
            <div>
              <p className="result-kicker">原文</p>
              <h3>逐句定位</h3>
            </div>
            <span>{data.paragraphs.length} 个段落</span>
          </div>
          {data.ignored && data.ignored.length > 0 && (
            <details className="ignored-blocks">
              <summary>{data.ignored.length} 处文字未参与评分（标题、过短内容或参考文献）</summary>
              <ul>
                {data.ignored.map((item, i) => (
                  <li key={i}><span>{item.reason}</span><p>{item.text}</p></li>
                ))}
              </ul>
            </details>
          )}
          {scanProgress && (
            <div className="scan-progress" role="status">
              <span>正在逐句打分：{scanProgress.done} / {scanProgress.total} 段</span>
              <span className="track">
                <span className="fill" style={{ width: `${Math.round((scanProgress.done / Math.max(1, scanProgress.total)) * 100)}%` }} />
              </span>
            </div>
          )}
          {highlighted && (
            <p className="fine">红色标记为本次模型分数最高的句子；浅红和浅黄表示较高分段。点分析条目可跳转到原文。</p>
          )}
          <ol className="paras">
            {listed.map((p) => (
              <Para
                key={p.index}
                para={p}
                lang={data.lang}
                topKeys={topKeys}
                locked={false}
                rechecking={recheckingIndex === p.index}
                onRecheck={onRecheck}
                onScan={onScan}
              />
            ))}
          </ol>
          {collapsed.length > 0 && (
            <details className="short-paras">
              <summary>另有 {collapsed.length} 个过短的段（不足 {SHORT_PARAGRAPH_CHARS} 字，单独打分不稳定，仅供参考）</summary>
              <ol className="paras">
                {collapsed.map((p) => (
                  <Para
                    key={p.index}
                    para={p}
                    lang={data.lang}
                    topKeys={topKeys}
                    locked={false}
                    rechecking={recheckingIndex === p.index}
                    onRecheck={onRecheck}
                    onScan={onScan}
                  />
                ))}
              </ol>
            </details>
          )}
        </div>
        <aside className="analysis-sidebar" aria-label="检测分析">
          <CompositionPanel lang={data.lang} comp={comp} />
          <SuspectList lang={data.lang} suspects={suspects} />
          <div className="analysis-section">
            <h3>各段模型分数</h3>
            <ScoreBars paragraphs={data.paragraphs} />
          </div>
          <details className="method-note">
            <summary>判断方法与局限</summary>
            <p>{data.basis || data.explanation}</p>
            <p>{data.reading}</p>
            <p>文本充分度：{CONF_LABEL[data.confidence]}。这一档只由文本长度和各段分数一致程度计算，不能表示模型判断正确的概率。</p>
            <p>{data.disclaimer}</p>
          </details>
          <div className="insight">
            <MarkerPanel markers={data.markers} />
            <RhythmChart rhythm={data.rhythm} />
          </div>
        </aside>
      </div>
    </section>
  );
}

export function Compare({ before, after }: { before: DetectOk; after: DetectOk }) {
  if (sameScores(before, after)) {
    return (
      <section className="compare">
        <h2>修改前后</h2>
        <p>初稿已记下。改完并重测后，这里会并排比较。</p>
      </section>
    );
  }
  const paired = after.paragraphs.map((p) => ({
    after: p,
    before: before.paragraphs.find((item) => item.index === p.index),
  }));
  return (
    <section className="compare">
      <h2>修改前后</h2>
      <p className="compare-total">
        初稿 {formatPercent(before.score)}%（{VERDICT_LABEL[before.verdict]}） → 现在{" "}
        {formatPercent(after.score)}%（{VERDICT_LABEL[after.verdict]}）
      </p>
      <ol>
        {paired.map(({ before: prev, after: next }) => {
          if (!prev) {
            return (
              <li key={next.index}>
                第 {next.index + 1} 段是后来多出来的：{formatPercent(next.score)}%
              </li>
            );
          }
          return (
            <li key={next.index}>
              第 {next.index + 1} 段 {formatPercent(prev.score)}% → {formatPercent(next.score)}%
            </li>
          );
        })}
      </ol>
      {before.paragraphs.length !== after.paragraphs.length && (
        <p className="fine">段数变过，只按现在的序号去对初稿里的同一段。</p>
      )}
    </section>
  );
}
