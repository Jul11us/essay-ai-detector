import { useMemo } from "react";
import { formatPercent } from "./copy";
import type { DetectOk } from "./types";
import { alignParagraphs, diffText } from "./versions";

export function Compare({ before, after }: { before: DetectOk; after: DetectOk }) {
  const pairs = useMemo(() => alignParagraphs(before,after).map((pair) => ({...pair,diff:diffText(pair.before?.text || pair.before?.excerpt || "",pair.after?.text || pair.after?.excerpt || "")})),[before,after]);
  const sameModel = before.model_id === after.model_id && before.model_revision === after.model_revision;
  const change = after.score-before.score;
  const unpaired = before.paragraphs.length*after.paragraphs.length>40000;
  const changed = pairs.filter((p) => !p.before || !p.after || p.diff.chunks.some((c) => c.kind !== "same"));
  return <section className="compare" aria-label="版本文字与分数对比">
    <div className="compare-summary"><div><span>左侧模型分数</span><strong>{formatPercent(before.score)}%</strong></div><div><span>右侧模型分数</span><strong>{formatPercent(after.score)}%</strong></div><div><span>分数变化</span><strong>{sameModel ? `${change>0 ? "+" : ""}${(change*100).toFixed(1)} 个百分点` : "模型不同"}</strong></div></div>
    {!sameModel && <p className="task-save-warning">两份记录的模型或版本不同。分数不直接比较，请查看各自模型：{before.model_id} ({before.model_revision || "未记录版本"}) / {after.model_id} ({after.model_revision || "未记录版本"})。</p>}
    <div className="diff-legend">{!unpaired && <><span className="diff-remove">删除文字</span><span className="diff-add">新增文字</span></>}<span>{unpaired ? "全文分别展示 · 未对齐段落" : `${changed.length} 处段落文字变化 · 共 ${pairs.length} 组`}</span></div>
    <p className="fine">段落按文字相似度与顺序对齐，保留两侧实际段号。分数变化仅表示模型估计变化。</p>
    {before.paragraphs.length*after.paragraphs.length>40000 && <p className="fine">段落较多，已分别展示两份全文，不推断段落对应关系。</p>}
    <ol className="diff-pairs">{pairs.map((pair,i) => <li className="diff-pair" key={i}>{(["before","after"] as const).map((side) => {
      const para = pair[side];
      return <div key={side} className="diff-side"><header><span>{side === "before" ? "左侧" : "右侧"} · {para ? `第 ${para.index+1} 段` : unpaired ? "未配对" : side === "before" ? "新增段落" : "删除段落"}</span>{para && <strong>{formatPercent(para.score)}%</strong>}</header>
        <p>{para ? unpaired ? para.text || para.excerpt : pair.diff.chunks.filter((c) => c.kind !== (side === "before" ? "add" : "remove")).map((chunk,j) => chunk.kind === "remove" ? <del key={j}>{chunk.text}</del> : chunk.kind === "add" ? <ins key={j}>{chunk.text}</ins> : <span key={j}>{chunk.text}</span>) : <span className="diff-empty">{unpaired ? "未推断对应关系" : "此版本没有这一段"}</span>}</p>
      </div>;
    })}{!pair.diff.granular && <p className="fine diff-fallback">改动较长，按整段标注增删。</p>}</li>)}</ol>
  </section>;
}
