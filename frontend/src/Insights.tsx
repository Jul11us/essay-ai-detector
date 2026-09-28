import type { MarkerHit, ParagraphHit, Rhythm } from "./types";
import { VERDICT_LABEL, formatPercent } from "./copy";

export function MarkerPanel({ markers }: { markers?: MarkerHit[] }) {
  const rows = markers ?? [];
  return (
    <aside className="markers">
      <h2>写作特征提示</h2>
      <p className="fine">
        只提示，不改原文。这些是可观察的套话。它们可能出现在人写和 AI 写的文本中，不是模型分数的因果解释。
      </p>
      {rows.length === 0 ? (
        <p>清单里的典型套话，这篇一次都没出现。</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.phrase}>
              <span>{row.phrase}</span>
              <strong>×{row.count}</strong>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export function RhythmChart({ rhythm }: { rhythm?: Rhythm }) {
  if (!rhythm) return null;
  const lengths = rhythm.lengths;
  const w = 320;
  const h = 96;
  const max = Math.max(...lengths, 1);
  const points =
    lengths.length >= 2
      ? lengths
          .map((n, i) => {
            const x = (i / (lengths.length - 1)) * (w - 12) + 6;
            const y = h - 14 - (n / max) * (h - 24);
            return `${x},${y}`;
          })
          .join(" ")
      : "";
  return (
    <aside className="rhythm">
      <h2>句长波动 · {rhythm.label}</h2>
      <p className="fine">{rhythm.note}</p>
      {points && (
        <svg viewBox={`0 0 ${w} ${h}`} className="rhythm-svg" role="img" aria-label={rhythm.note}>
          <polyline fill="none" stroke="#3f5c4a" strokeWidth="2" points={points} />
        </svg>
      )}
    </aside>
  );
}

export function ScoreBars({ paragraphs }: { paragraphs: ParagraphHit[] }) {
  return (
    <div className="bars">
      {paragraphs.map((p) => (
        <div className="bar-row" key={p.index}>
          <span>第 {p.index + 1} 段</span>
          <span className="track" aria-hidden="true">
            <span
              className={`fill ${p.verdict}`}
              style={{ width: `${Math.max(2, p.score * 100)}%` }}
            />
          </span>
          <span>
            {formatPercent(p.score)}% · {VERDICT_LABEL[p.verdict]}
          </span>
        </div>
      ))}
    </div>
  );
}
