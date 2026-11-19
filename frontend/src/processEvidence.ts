import type { Outcome } from "./aggregate";
import { isBilingual, isSectionErr, type ScoreLang } from "./types";
import { diffText } from "./versions";

type Assessment = "supports" | "diverges" | "review" | "context";

export type ProcessEvidence = { kind: "none" }
  | { kind: "bulk"; assessment: Assessment; share: number }
  | { kind: "revisions"; assessment: Assessment; count: number }
  | { kind: "mixed"; assessment: "context"; count: number };

function section(result: Outcome, lang: ScoreLang) {
  const part = isBilingual(result) ? result[lang] : result;
  return part && !isSectionErr(part) && part.lang === lang ? part : null;
}

function manuscript(result: ReturnType<typeof section>) {
  if (!result?.paragraphs.length || result.paragraphs.some((p) => !p.text)) return null;
  return result.paragraphs.map((p) => p.text).join("\n\n");
}

const chars = (text: string) => Array.from(text.replace(/\s/gu, "")).length;

function changedSpan(before: string, after: string) {
  let start = 0, end = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start++;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return {
    added: chars(after.slice(start, after.length - end)),
    removed: chars(before.slice(start, before.length - end)),
  };
}

function measureChanges(before: string, after: string) {
  const span = changedSpan(before, after);
  if (!span.removed || !span.added) return { ...span, contiguousAddition: !span.removed };

  const { chunks, granular } = diffText(before, after);
  if (!granular) return null;
  let added = 0, removed = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "add") added += chars(chunk.text);
    if (chunk.kind === "remove") removed += chars(chunk.text);
  }
  return { added, removed, contiguousAddition: false };
}

export function assessProcess(result: Outcome, lang: ScoreLang): ProcessEvidence {
  const current = section(result, lang);
  const final = manuscript(current);
  const versions = result.version_history ?? [];
  let after = manuscript(section(versions.at(-1)?.result ?? result, lang));
  if (!current || !final || final !== after) return { kind: "none" };

  const events = new Map(result.writing_process?.events.map((event) => [event.version_id, event]));
  let count = 0;
  let largeChange = false;
  for (let i = versions.length - 1; i > 0; i--) {
    const event = events.get(versions[i].id);
    if (event?.origin !== "action" || event.comparison_base_id !== versions[i - 1].id || event.kind === "restore") break;
    const before = manuscript(section(versions[i - 1].result, lang));
    if (before === null || after === null) break;
    if (before !== after) {
      if (event.kind !== "recheck") break;
      const changes = measureChanges(before, after);
      if (!changes) break;
      const { added, removed, contiguousAddition } = changes;
      if (added || removed) {
        // Only the latest text change can establish the share still present in the current draft.
        const afterSize = chars(after);
        if (!count && contiguousAddition && added >= 200 && added * 2 >= afterSize) {
          return {
            kind: "bulk",
            share: added / afterSize,
            assessment: current.verdict === "high" ? "supports" : current.verdict === "low" ? "review" : "context",
          };
        }
        largeChange ||= Math.max(added, removed) >= 200 && Math.max(added, removed) * 2 >= afterSize;
        count++;
      }
    }
    after = before;
  }
  if (count < 2) return { kind: "none" };
  if (largeChange) return { kind: "mixed", assessment: "context", count };
  return { kind: "revisions", assessment: current.verdict === "high" ? "diverges" : "context", count };
}
