import { useId, useRef, useState } from "react";
import type { Outcome } from "./aggregate";
import type { WritingEvent, WritingEventKind } from "./types";
import { isBilingual, isSectionErr } from "./types";
import { REVIEW_LABEL } from "./reviews";

const KIND: Record<WritingEventKind, string> = { initial: "检测起点", manual: "保存版本", recheck: "修改重测", restore: "恢复版本", checkpoint: "自动留档", review: "句子复核" };
const timestamp = (value: string) => new Date(value).toLocaleString("zh-CN", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false });

export function WritingTimeline({ data, onCompare }: { data: Outcome; onCompare: (left: string, right: string) => void }) {
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const process = data.writing_process;
  const events = process?.events || [];
  const versions = data.version_history || [];
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(8);
  const [selection, setSelection] = useState<string | null>(null);
  const filtered = events.filter((event) => filter === "all" || (filter === "versions" ? event.kind !== "review" : event.kind === filter));
  const selected = filtered.find((event) => event.id === selection) || filtered.at(-1);
  const version = versions.find((entry) => entry.id === selected?.version_id);
  const base = versions.find((entry) => entry.id === selected?.comparison_base_id);
  const snapshot: Outcome | undefined = version?.result;
  const parts = snapshot ? isBilingual(snapshot) ? [snapshot.en, snapshot.zh].flatMap((p) => p && !isSectionErr(p) ? [p] : []) : [snapshot] : [];
  const visible = filtered.slice(-limit);
  const choose = (event: WritingEvent) => {
    setSelection(event.id);
    if (window.matchMedia("(max-width:800px)").matches) requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ block:"start", behavior:window.matchMedia("(prefers-reduced-motion:reduce)").matches ? "instant" : "smooth" });
      detailRef.current?.focus({preventScroll:true});
    });
  };
  return <section className="writing-timeline" aria-label="写作过程时间线">
    <div className="timeline-intro"><div><span className="result-kicker">YOUR WRITING JOURNEY</span><h3>每一次修改，都有迹可循。</h3><p>检测与复核操作记录。选择节点，回看当时的稿件或批注。</p></div><dl className="timeline-stats"><div><dt>修改重测</dt><dd>{process?.rechecks || 0}</dd></div><div><dt>复核记录</dt><dd>{process?.reviews || 0}</dd></div><div><dt>保留版本</dt><dd>{versions.length}</dd></div></dl></div>
    <div className="timeline-toolbar"><label>浏览记录<select aria-label="时间线记录类型" value={filter} onChange={(e) => { setFilter(e.target.value); setLimit(8); setSelection(null); }}><option value="all">全部操作</option><option value="versions">稿件与版本</option><option value="recheck">修改重测</option><option value="review">句子复核</option><option value="restore">恢复版本</option></select></label><span className="fine">{filtered.length ? `${visible.length} / ${filtered.length} 条记录` : "暂无这类记录"}</span></div>
    <div className="timeline-workspace"><div className="timeline-track">
      {filtered.length > limit && <button className="text-btn timeline-earlier" type="button" onClick={() => setLimit((n) => n + 8)}>查看更早记录</button>}
      <ol className="timeline-list">{visible.map((event) => <li key={event.id} className={selected?.id === event.id ? "is-selected" : ""} data-kind={event.kind}><button type="button" aria-current={selected?.id === event.id ? "step" : undefined} aria-controls={detailId} onClick={() => choose(event)}><span className="timeline-node-meta"><span>{KIND[event.kind]}</span><time dateTime={event.created_at}>{timestamp(event.created_at)}</time></span><strong>{event.label}</strong>{event.review && <span className="timeline-node-caption">{event.review.lang === "zh" ? "中文" : "英文"} · 第 {event.review.paragraph_index + 1} 段 · {event.review.state ? REVIEW_LABEL[event.review.state] : "已清除"}</span>}{event.origin === "version" && <span className="timeline-node-caption">来自已有版本</span>}</button></li>)}</ol>
      {!filtered.length && <p className="timeline-empty">此任务还没有这类操作记录。</p>}
    </div><div className="timeline-detail" id={detailId} ref={detailRef} tabIndex={-1} role="region" aria-label="时间线记录详情" aria-live="polite">
      {selected ? <><span className="timeline-detail-kind">{KIND[selected.kind]}</span><h4>{selected.label}</h4><time dateTime={selected.created_at}>{new Date(selected.created_at).toLocaleString("zh-CN")}</time>
        {selected.origin === "version" && <p className="fine">按原保存时间接入，仅比较现有留档；更早或已移除的过程没有记录。</p>}
        {selected.review ? <><p className="timeline-location">当时位置：{selected.review.lang === "zh" ? "中文" : "英文"}第 {selected.review.paragraph_index + 1} 段，第 {selected.review.sentence_index + 1} 句</p><blockquote>{selected.review.excerpt}{selected.review.excerpt.length === 120 ? "…" : ""}</blockquote><div className="timeline-note"><span>{selected.review.state ? REVIEW_LABEL[selected.review.state] : "当时已清除批注"}</span><p>{selected.review.note || "当时没有文字批注。"}</p></div>{selected.review.updates > 1 && <p className="fine">连续编辑合并为此节点 · 最后保存 {timestamp(selected.updated_at)}</p>}<p className="fine">这是当时的复核记录，正文和句子位置可能已改变。</p></> : version ? <><dl className="timeline-version-facts">{parts.map((part) => part && !isSectionErr(part) && <div key={part.lang}><dt>{part.lang === "en" ? "英文" : "中文"}快照</dt><dd>{part.paragraphs.length} 段 · {part.char_count} 字符<span>AI 写作倾向（模型估计）{(part.score * 100).toFixed(1)}%</span></dd></div>)}</dl><button type="button" className="eval-primary" onClick={() => base ? onCompare(base.id, version.id) : onCompare(version.id, "current")}>{base ? selected.origin === "version" ? "与前一留档对比" : "查看这次修改" : "与当前结果对比"}<span aria-hidden="true"> ↗</span></button><p className="fine">打开对比仅用于查看。需要恢复时，在下方选择版本。</p></> : <p className="timeline-unavailable">这条操作仍在记录中；对应稿件快照已超出保留范围，无法回看全文。</p>}</> : <p className="fine">保存版本或完成句子复核后，记录会显示在这里。</p>}
    </div></div>
    <p className="timeline-retention fine">记录本页面的检测、重测、批注与版本操作；不追踪外部编辑或键盘输入，也不估算写作时长。{process && process.total_events > events.length ? `累计 ${process.total_events} 个节点，仅保留起点与最近 199 个。` : "最多保留起点与最近 199 个节点。"} 清除当前批注后，历史记录仍保留；删除任务可一并移除。</p>
  </section>;
}
