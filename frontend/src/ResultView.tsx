import { useEffect, useState } from "react";
import { MarkerPanel, RhythmChart, ScoreBars } from "./Insights";
import { CompositionPanel } from "./CompositionPanel";
import { suspectKey, topSuspects, type Suspect } from "./aggregate";
import { composition } from "./composition";
import {
  RAW_SCORE_NOTE,
  verdictReasons,
  CONF_LABEL,
  SHORT_PARAGRAPH_CHARS,
  formatPercent,
  isShortParagraph,
} from "./copy";
import { jumpTo, sentenceDomId } from "./domIds";
import { buildResultCsv, buildResultJson, downloadCsv, downloadJson } from "./export";
import { Para } from "./ParagraphView";
import { CalibrationNote } from "./CalibrationNote";
import { buildReportHtml, downloadReport, printReport } from "./report";
import { WordReportButton } from "./WordReportButton";
import { ExportMenu } from "./ExportMenu";
import type { DetectOk, SentenceReview } from "./types";
import { ScopeSummary } from "./ScopeSelector";
import { ReviewSidebar, focusSentence, reviewItems, type ReviewTarget } from "./ReviewSidebar";
import type { ProcessEvidence } from "./processEvidence";

export { Compare } from "./Compare";

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

function ProcessAssessment({ evidence }: { evidence: ProcessEvidence }) {
  if (evidence.kind === "none") return <div className="process-assessment">
    <h3>写作过程辅助评估：暂无过程证据</h3>
    <p>没有足够的留档可核对正文变化。记录缺失不代表稿件没有修改过。</p>
  </div>;

  const label = {
    supports: "与较高档信号一致，仍需人工复核",
    diverges: "与较高档信号不一致，建议人工复核",
    review: "虽为较低档，建议核对大段新增内容",
    context: "提供复核线索，不改变分档",
  }[evidence.assessment];
  const reason = evidence.kind === "bulk"
    ? `最近一次有文字变化的重测中新增了一整块文字，约占当前正文的 ${Math.round(evidence.share * 100)}%。`
    : `当前稿件可核对到 ${evidence.count} 次修改重测；${{
      mixed: "其中有大幅改动，不能判断写作是逐步完成还是集中完成。",
      unmeasured: "其中有改动超出精细对比范围，无法判断改动幅度。",
      revisions: "正文分多次修改，单看最终分数无法反映这些变化。",
    }[evidence.kind]}`;
  return <div className="process-assessment">
    <h3>写作过程辅助评估：{label}</h3>
    <p>{reason}</p>
    <p>只依据本机留档，不记录键盘输入或外部写作。大段新增也可能是从其他编辑器转入，不能据此判断作者或文字来源；模型分数和分档不变。</p>
  </div>;
}

export function ResultCard({
  data,
  processEvidence,
  copied,
  onCopy,
  onSaveVersion,
  active = true,
  locked = false,
  reviewEpoch,
  onRecheck,
  onScan,
  recheckingIndex,
  scanProgress,
  onReview,
}: {
  data: DetectOk;
  processEvidence: ProcessEvidence;
  copied: boolean;
  onCopy: (data: DetectOk) => void;
  onSaveVersion: () => void;
  active?: boolean;
  locked?: boolean;
  reviewEpoch?: string;
  onRecheck: (index: number, text: string) => Promise<string | null>;
  onScan: (index: number) => Promise<void>;
  recheckingIndex: number | null;
  scanProgress: { done: number; total: number } | null;
  onReview?: (para: number, sentence: number, text: string, review: SentenceReview | null) => void;
}) {
  const [selection, setSelection] = useState<ReviewTarget | null>(null);
  const selected = active && selection && reviewItems(data).some((item) => item.para === selection.para && item.sentence === selection.sentence && item.text === selection.text) ? selection : null;
  useEffect(() => { if (!active) setSelection(null); }, [active]);
  function closeReview() {
    if(selected) {
      const target = selected;
      setSelection(null);
      requestAnimationFrame(() => focusSentence(data.lang,target));
    }
  }
  const percent = formatPercent(data.score);
  const verdict = verdictReasons(data);
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
    low: "AI 写作倾向较低",
    uncertain: "AI 写作倾向不确定",
    high: "AI 写作倾向较高",
  }[data.verdict];

  return (
    <section className="result" aria-live="polite">
      <div className="result-heading">
        <div>
          <p className="result-kicker">检测结果 · {data.lang === "zh" ? "中文" : "英文"}</p>
          <h2>{headline}</h2>
          <p className="result-lead">{data.verdict === "uncertain" && data.verdict_adjustment
            ? data.verdict_adjustment.note
            : data.confidence === "low"
            ? data.verdict === "high"
              ? "只有一个段落，文本充分度仍低；全文已达较高档，请对照原句和上下文人工复核。"
              : data.verdict === "low"
                ? "文本偏短或只有一个段落，较低分也不能说明是人写的。请查看原句和上下文。"
                : "文本偏短或只有一个段落，分数还不足以给出明确结论。请查看原句和上下文。"
            : "请先看标记的原句和上下文。单个分数不能证明文字来源。"}</p>
          {data.mixed_variance && <p className="mix">各段差异较大，建议逐段查看。</p>}
        </div>
        <div className={`result-score ${data.verdict}`} role="group" aria-label={`全文判定：${verdict.label}；模型原始分：${percent}%；${RAW_SCORE_NOTE}`}>
          <span className="result-score-label">全文判定</span>
          <strong>{verdict.label}</strong>
          <span className="result-raw-score">模型原始分：{percent}%</span>
          <small>{RAW_SCORE_NOTE}</small>
        </div>
        <div className="verdict-reasons">
          <h3>判定依据</h3>
          <ul>{verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>
        <ProcessAssessment evidence={processEvidence} />
      </div>
      <div className="result-actions">
        <WordReportButton data={data} />
        <button type="button" className="text-btn" onClick={() => onCopy(data)}>
          {copied ? "已复制" : "复制结果"}
        </button>
        <ExportMenu>
        <button type="button" className="text-btn" onClick={() => downloadReport(buildReportHtml(data), "ai-rate-report.html")}>
          导出 HTML 报告
        </button>
        <button type="button" className="text-btn" onClick={() => printReport(buildReportHtml(data))}>
          打印报告
        </button>
        <button type="button" className="text-btn" onClick={() => downloadJson(buildResultJson(data), "ai-rate-result.json")}>
          导出 JSON
        </button>
        <button type="button" className="text-btn" onClick={() => downloadCsv(buildResultCsv(data), "ai-rate-result.csv")}>
          导出 CSV
        </button>
        </ExportMenu>
        <button type="button" className="text-btn" disabled={locked} onClick={onSaveVersion}>
          保存当前版本
        </button>
      </div>
      <div className="result-layout">
        <div className="manuscript">
          {data.detection_scope && <ScopeSummary scope={data.detection_scope} />}
          {data.paragraphs.some((p) => p.sentences?.some((s) => s.review)) && <p className="review-summary">人工复核：{["reviewed", "pending", "revise"].map((state) => `${state === "reviewed" ? "已复核" : state === "pending" ? "待确认" : "需修改"} ${data.paragraphs.flatMap((p) => p.sentences || []).filter((s) => s.review?.state === state).length} 句`).join(" · ")}</p>}
          <div className="manuscript-heading">
            <div>
              <p className="result-kicker">原文</p>
              <h3>逐句定位</h3>
            </div>
            <span>{data.paragraphs.length} 个段落</span>
          </div>
          <p className="manuscript-help">点击原句查看说明并添加人工批注；在段落下方修改文字并重测。</p>
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
                locked={locked}
                rechecking={recheckingIndex === p.index}
                onRecheck={onRecheck}
                onScan={onScan}
                selected={selected}
                onSelect={setSelection}
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
                    locked={locked}
                    rechecking={recheckingIndex === p.index}
                    onRecheck={onRecheck}
                    onScan={onScan}
                    selected={selected}
                    onSelect={setSelection}
                  />
                ))}
              </ol>
            </details>
          )}
        </div>
        <aside className={`analysis-sidebar ${selected ? "has-selection" : ""}`} aria-label={`检测分析 · ${data.lang === "zh" ? "中文" : "英文"}`}>
          {selected && <ReviewSidebar key={reviewEpoch} data={data} selected={selected} onSelect={setSelection} onClose={closeReview} onReview={onReview} />}
          <details className="whole-analysis" open={!selected}><summary>全文分析</summary>
          <CompositionPanel lang={data.lang} comp={comp} />
          <SuspectList lang={data.lang} suspects={suspects} />
          <div className="analysis-section">
            <h3>各段模型分数</h3>
            <ScoreBars paragraphs={data.paragraphs} />
          </div>
          <details className="method-note">
            <summary>判断方法与局限</summary>
            <p className="model-name">检测模型：{data.model_id}</p>
            <p>{data.basis || data.explanation}</p>
            <p>{data.reading}</p>
            <CalibrationNote info={data.calibration} />
            <p>文本充分度：{CONF_LABEL[data.confidence]}。这一档只由文本长度和各段分数一致程度计算，不能表示模型判断正确的概率。</p>
            <p>{data.disclaimer}</p>
          </details>
          <div className="insight">
            <MarkerPanel markers={data.markers} />
            <RhythmChart rhythm={data.rhythm} />
          </div>
          </details>
        </aside>
      </div>
    </section>
  );
}
