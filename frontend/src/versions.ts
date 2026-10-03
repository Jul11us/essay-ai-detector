import type { Outcome } from "./aggregate";
import type { DetectOk, DocumentVersion, VersionOutcome, WritingEventKind } from "./types";
import { isBilingual, isSectionErr } from "./types";
import { appendEvent, ensureProcess } from "./writingProcess";

export const MAX_VERSIONS = 20;
export function snapshotResult(result: Outcome): VersionOutcome {
  // Strip history before cloning: a current-result export should not copy all
  // twenty full-text snapshots, even temporarily.
  const copy = { ...result };
  delete copy.version_history;
  delete copy.writing_process;
  if (isBilingual(copy)) for (const lang of ["en", "zh"] as const) {
    const part = copy[lang]; if (part && !isSectionErr(part)) { const body={...part}; delete body.version_history; delete body.writing_process; copy[lang]=body; }
  }
  return JSON.parse(JSON.stringify(copy)) as VersionOutcome;
}
function signature(result: Outcome) {
  const doc = (value: DetectOk) => [value.lang, value.model_id, value.model_revision, value.score,
    value.paragraphs.map((p) => [p.text || p.excerpt, p.score, (p.sentences || []).filter((s) => s.review).map((s) => [s.text, s.review])])];
  return JSON.stringify(isBilingual(result) ? ["bi", ...[result.en, result.zh].map((p) => p && !isSectionErr(p) ? doc(p) : p)] : doc(result));
}
export function appendVersion<T extends Outcome>(result: T, label: string, kind: DocumentVersion["kind"], force = false, eventKind: WritingEventKind = kind): T {
  result = ensureProcess(result);
  const history = result.version_history || [];
  if (!force && history.length && signature(history[history.length - 1].result) === signature(result)) return result;
  const entry: DocumentVersion = { id: crypto.randomUUID(), label:label.trim().slice(0,80) || "未命名版本", kind, created_at: new Date().toISOString(), result: snapshotResult(result) };
  const all = [...history, entry];
  const kept = all.length > MAX_VERSIONS ? [all[0], ...all.slice(-(MAX_VERSIONS - 1))] : all;
  return appendEvent({ ...result, version_history: kept }, { id: crypto.randomUUID(), kind: eventKind, label: entry.label, created_at: entry.created_at, updated_at: entry.created_at, origin: "action", version_id: entry.id, comparison_base_id: history.at(-1)?.id });
}
export function ensureVersions<T extends Outcome>(result: T, label="初始检测"): T { return result.version_history?.length ? ensureProcess(result) : appendVersion(result, label, "initial"); }
export function recordRecheck<T extends Outcome>(previous: Outcome, next: T, label: string): T {
  const before = appendVersion(ensureVersions(previous), "重测前的复核记录", "manual", false, "checkpoint");
  return appendVersion({ ...next, version_history: before.version_history, writing_process: before.writing_process }, label, "recheck");
}

export type DiffChunk = { kind: "same" | "remove" | "add"; text: string };
const tokens = (text: string) => text.match(/\s+|[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu) || [];
export function diffText(before: string, after: string): { chunks: DiffChunk[]; granular: boolean } {
  if (before === after) return { chunks: [{kind:"same",text:before}], granular:true };
  const left = tokens(before), right = tokens(after);
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start && left[left.length-1-end] === right[right.length-1-end]) end++;
  const a = left.slice(start, left.length-end), b = right.slice(start, right.length-end);
  const chunks: DiffChunk[] = [];
  const push = (kind: DiffChunk["kind"], text: string) => {
    if (!text) return; const last = chunks[chunks.length-1]; if (last?.kind === kind) last.text += text; else chunks.push({kind,text});
  };
  push("same",left.slice(0,start).join(""));
  const granular = a.length * b.length <= 600_000;
  if (!granular) { push("remove",a.join("")); push("add",b.join("")); }
  else {
    const width = b.length + 1, grid = new Uint32Array((a.length+1)*width);
    for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) grid[i*width+j] = a[i]===b[j] ? grid[(i+1)*width+j+1]+1 : Math.max(grid[(i+1)*width+j],grid[i*width+j+1]);
    let i=0,j=0;
    while(i<a.length || j<b.length) {
      if(i<a.length && j<b.length && a[i]===b[j]) { push("same",a[i]); i++;j++; }
      else if(i<a.length && (j===b.length || grid[(i+1)*width+j]>=grid[i*width+j+1])) push("remove",a[i++]);
      else push("add",b[j++]);
    }
  }
  if(end) push("same",left.slice(left.length-end).join(""));
  return {chunks,granular};
}

export type ParagraphPair = { before?: DetectOk["paragraphs"][number]; after?: DetectOk["paragraphs"][number] };
export function alignParagraphs(before: DetectOk, after: DetectOk): ParagraphPair[] {
  const a = before.paragraphs, b = after.paragraphs;
  // Bound work for very large documents; display each side independently rather
  // than inventing a correspondence by matching paragraph numbers.
  if (a.length*b.length > 40_000) return [...a.map((before)=>({before})),...b.map((after)=>({after}))];
  const text = (p: DetectOk["paragraphs"][number]) => p.text || p.excerpt;
  const stop = new Set(["a","an","the","and","or","of","to","in","on","for","is","was","we","it","with"]);
  const sets = (p: DetectOk["paragraphs"][number]) => new Set(tokens(text(p).toLowerCase()).filter((t)=>/[\p{L}\p{N}]/u.test(t) && !stop.has(t)).slice(0,150));
  const left = a.map(sets), right = b.map(sets);
  const width = b.length+1, costs = new Float64Array((a.length+1)*width);
  const weight = (i:number,j:number) => {
    if(text(a[i])===text(b[j])) return 0;
    let shared=0; for(const word of left[i]) if(right[j].has(word)) shared++;
    const similarity = 2*shared/(left[i].size+right[j].size || 1);
    return a.length===1 && b.length===1 ? 1 : similarity < .08 ? 2.1 : 1.6-similarity;
  };
  for(let i=a.length;i>=0;i--) for(let j=b.length;j>=0;j--) {
    if(i===a.length) costs[i*width+j]=b.length-j;
    else if(j===b.length) costs[i*width+j]=a.length-i;
    else costs[i*width+j]=Math.min(weight(i,j)+costs[(i+1)*width+j+1],1+costs[(i+1)*width+j],1+costs[i*width+j+1]);
  }
  const pairs: ParagraphPair[]=[]; let i=0,j=0;
  while(i<a.length || j<b.length) {
    const at=costs[i*width+j];
    if(i<a.length && j<b.length && Math.abs(at-weight(i,j)-costs[(i+1)*width+j+1])<1e-8) pairs.push({before:a[i++],after:b[j++]});
    else if(i<a.length && (j===b.length || Math.abs(at-1-costs[(i+1)*width+j])<1e-8)) pairs.push({before:a[i++]});
    else pairs.push({after:b[j++]});
  }
  return pairs;
}
