import type { Outcome } from "./aggregate";
import { isBilingual, isSectionErr, type ScoreLang } from "./types";
import { diffText } from "./versions";

type Assessment = "supports" | "diverges" | "review" | "context";

export type ProcessEvidence = { kind: "none" }
  | { kind: "bulk"; assessment: Assessment; share: number }
  | { kind: "revisions"; assessment: Assessment; count: number }
  | { kind: "mixed" | "unmeasured"; assessment: "context"; count: number };

type Manuscript = { text: string; compact: string; wording: string; unknownJoins: Set<number> };

function section(result: Outcome, lang: ScoreLang) {
  const part = isBilingual(result) ? result[lang] : result;
  return part && !isSectionErr(part) && part.lang === lang ? part : null;
}

const withoutSpace = (text: string) => text.replace(/\s/gu, "");
const chars = (text: string) => Array.from(withoutSpace(text)).length;

function manuscript(result: ReturnType<typeof section>): Manuscript | null {
  if (!result?.paragraphs.length || result.paragraphs.some((p) => !p.text)) return null;
  const parts: string[] = [];
  const unknownJoins = new Set<number>();
  let offset = 0;
  for (const [i, paragraph] of result.paragraphs.entries()) {
    if (i && paragraph.joins_previous === undefined) unknownJoins.add(offset);
    const text = paragraph.text!;
    parts.push((i && !paragraph.joins_previous ? "\n\n" : "") + text);
    offset += withoutSpace(text).length;
  }
  const text = parts.join("");
  const compact = withoutSpace(text);
  const wording = result.lang === "en"
    ? text.replace(/\s+/gu, " ").replace(/(?<![\p{L}\p{M}\p{N}]) | (?![\p{L}\p{M}\p{N}])/gu, "")
    : compact;
  return { text, compact, wording, unknownJoins };
}

function onlyUnknownJoinsDiffer(before: Manuscript, after: Manuscript) {
  if (before.compact !== after.compact || (!before.unknownJoins.size && !after.unknownJoins.size)) return false;
  const ignoreUnknownJoins = (wording: string) => {
    let spaces = 0;
    return wording.replace(/ /gu, (_space, index: number) => {
      const offset = index - spaces++;
      return before.unknownJoins.has(offset) || after.unknownJoins.has(offset) ? "" : " ";
    });
  };
  return ignoreUnknownJoins(before.wording) === ignoreUnknownJoins(after.wording);
}

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

function measureChanges(before: Manuscript, after: Manuscript) {
  const span = changedSpan(before.compact, after.compact);
  if (span.added !== span.removed && (!span.removed || !span.added)) return { ...span, contiguousAddition: !span.removed };

  const { chunks, granular } = diffText(before.text, after.text);
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
  if (!current || !final?.compact || final.wording !== after?.wording) return { kind: "none" };

  const events = new Map(result.writing_process?.events.map((event) => [event.version_id, event]));
  let count = 0;
  let largeChange = false;
  let unmeasuredChange = false;
  for (let i = versions.length - 1; i > 0; i--) {
    const event = events.get(versions[i].id);
    if (event?.origin !== "action" || event.comparison_base_id !== versions[i - 1].id || event.kind === "restore") break;
    const before = manuscript(section(versions[i - 1].result, lang));
    if (before === null || after === null) break;
    if (before.wording !== after.wording) {
      if (event.kind !== "recheck" || onlyUnknownJoinsDiffer(before, after)) break;
      const changes = measureChanges(before, after);
      if (changes) {
        const { added, removed, contiguousAddition } = changes;
        // Only the latest text change can establish the share still present in the current draft.
        const afterSize = chars(after.compact);
        if (!count && contiguousAddition && added >= 200 && added * 2 >= afterSize) {
          return {
            kind: "bulk",
            share: added / afterSize,
            assessment: current.verdict === "high" ? "supports" : current.verdict === "low" ? "review" : "context",
          };
        }
        largeChange ||= Math.max(added, removed) >= 200 && Math.max(added, removed) * 2 >= afterSize;
      } else {
        unmeasuredChange = true;
      }
      count++;
    }
    after = before;
  }
  if (count < 2) return { kind: "none" };
  if (largeChange) return { kind: "mixed", assessment: "context", count };
  if (unmeasuredChange) return { kind: "unmeasured", assessment: "context", count };
  return { kind: "revisions", assessment: current.verdict === "high" ? "diverges" : "context", count };
}
