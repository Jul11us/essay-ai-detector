import type { Outcome } from "./aggregate";
import type { SentenceReview, WritingEvent, WritingProcess } from "./types";
import { isBilingual, isSectionErr } from "./types";

export const MAX_WRITING_EVENTS = 200;

/** Older tasks have timestamps for snapshots only. Keep their source explicit. */
export function ensureProcess<T extends Outcome>(result: T): T {
  if (result.writing_process) return result;
  const versions = result.version_history || [];
  const events: WritingEvent[] = versions.map((version, i) => ({
    id: `version:${version.id}`, kind: version.kind, label: version.label,
    created_at: version.created_at, updated_at: version.created_at, origin: "version",
    version_id: version.id, comparison_base_id: versions[i - 1]?.id,
  }));
  return { ...result, writing_process: { events, total_events: events.length, rechecks: events.filter((e) => e.kind === "recheck").length, reviews: 0 } };
}

export function appendEvent<T extends Outcome>(result: T, event: WritingEvent): T {
  const current = ensureProcess(result);
  const process = current.writing_process!;
  const events = [...process.events, event];
  const next: WritingProcess = {
    events: events.length > MAX_WRITING_EVENTS ? [events[0], ...events.slice(-(MAX_WRITING_EVENTS - 1))] : events,
    total_events: process.total_events + 1,
    rechecks: process.rechecks + Number(event.kind === "recheck"),
    reviews: process.reviews + Number(event.kind === "review"),
  };
  return { ...current, writing_process: next };
}

/** Log a real annotation change; scanning and timestamp-only saves are silent. */
export function recordReview<T extends Outcome>(previous: Outcome, next: T, side: "en" | "zh" | "single", paragraphIndex: number, sentenceIndex: number, expectedText: string, review: SentenceReview | null): T {
  const section = isBilingual(previous) ? (side !== "single" ? previous[side] : null) : previous;
  if (!section || isSectionErr(section)) return next;
  const sentence = section.paragraphs.find((p) => p.index === paragraphIndex)?.sentences?.[sentenceIndex];
  if (!sentence || sentence.text !== expectedText) return next;
  if ((sentence.review?.state ?? null) === (review?.state ?? null) && (sentence.review?.note ?? "") === (review?.note ?? "")) return next;
  const current = { ...ensureProcess(next), writing_process: ensureProcess(previous).writing_process! };
  const now = new Date().toISOString();
  const detail: NonNullable<WritingEvent["review"]> = { lang: section.lang, paragraph_index: paragraphIndex, sentence_index: sentenceIndex, excerpt: expectedText.slice(0, 120), state: review?.state ?? null, note: (review?.note ?? "").slice(0, 2000), updates: 1 };
  const last = current.writing_process.events.at(-1);
  const elapsed = last ? Date.parse(now) - Date.parse(last.updated_at) : Infinity;
  // Debounced typing is one operation, but a state change or another action starts a new node.
  if (last?.kind === "review" && last.review && last.review.lang === detail.lang && last.review.paragraph_index === paragraphIndex && last.review.sentence_index === sentenceIndex && last.review.excerpt === detail.excerpt && last.review.state === detail.state && elapsed >= 0 && elapsed < 60_000) {
    return { ...current, writing_process: { ...current.writing_process, events: [...current.writing_process.events.slice(0, -1), { ...last, updated_at: now, review: { ...detail, updates: last.review.updates + 1 } }] } } as T;
  }
  return appendEvent(current, { id: crypto.randomUUID(), kind: "review", label: review ? "更新句子复核" : "清除当前批注", created_at: now, updated_at: now, origin: "action", review: detail }) as T;
}
