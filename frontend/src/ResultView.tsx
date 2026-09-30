import { MarkerPanel, RhythmChart, ScoreBars } from "./Insights";
import { CompositionPanel } from "./CompositionPanel";
import { suspectKey, topSuspects, type Suspect } from "./aggregate";
import { composition } from "./composition";
import {
  CONF_LABEL,
  SHORT_PARAGRAPH_CHARS,
  formatPercent,
  isShortParagraph,
} from "./copy";
import { jumpTo, sentenceDomId } from "./domIds";
import { buildResultCsv, buildResultJson, downloadCsv, downloadJson } from "./export";
import { Para } from "./ParagraphView";
import { buildReportHtml, downloadReport, printReport } from "./report";
import type { DetectOk } from "./types";

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
        <div className="result-score">
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
        <button type="button" className="text-btn" onClick={() => downloadJson(buildResultJson(data), "ai-rate-result.json")}>
          导出 JSON
        </button>
        <button type="button" className="text-btn" onClick={() => downloadCsv(buildResultCsv(data), "ai-rate-result.csv")}>
          导出 CSV
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
        <aside className="analysis-sidebar" aria-label={`检测分析 · ${data.lang === "zh" ? "中文" : "英文"}`}>
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
