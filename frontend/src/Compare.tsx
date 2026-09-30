import { sameScores } from "./aggregate";
import { VERDICT_LABEL, formatPercent } from "./copy";
import type { DetectOk } from "./types";

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
