import { spanPlace, unitPlace, type Composition } from "./composition";
import { formatPercent } from "./copy";
import { jumpTo, unitDomId } from "./domIds";

const BAND_LABEL = { ai: "较高分", unclear: "不确定", human: "较低分" } as const;

export function CompositionPanel({ lang, comp }: { lang: string; comp: Composition }) {
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
      <div className="compo-strip" role="group" aria-label="全文分布，按原文顺序">
        {comp.units.map((u) => (
          <button
            key={`${u.paraIndex}:${u.sentIndex ?? "p"}`}
            type="button"
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
