import { expect, it } from "vitest";
import { keepReviews } from "./reviews";
import { interruptedBatch, interruptedEvaluation } from "./tasks";
import type { SentenceHit } from "./types";

const sentence = (text: string): SentenceHit => ({
  text,
  score: 0.8,
  verdict: "high",
  highlight: "high",
});
const review = { state: "reviewed", note: "checked", updated_at: "2026-10-03T00:00:00Z" } as const;

it("keeps reviews only on unchanged text and respects repeated-sentence order", () => {
  const old = [
    sentence("Repeated."),
    { ...sentence("Repeated."), review },
    { ...sentence("Changed."), review },
  ];
  const next = keepReviews(old, [
    sentence("Repeated."),
    sentence("Repeated."),
    sentence("Changed wording."),
  ]);
  expect(next[0].review).toBeUndefined();
  expect(next[1].review).toEqual(review);
  expect(next[2].review).toBeUndefined();
  expect(next[2].score).toBe(0.8);
});
it("cleared reviews do not reappear from an older result snapshot", () => {
  expect(
    keepReviews([sentence("Same.")], [{ ...sentence("Same."), review }])[0].review,
  ).toBeUndefined();
});
it("interrupted jobs preserve finished results and only pause pending work", () => {
  const rows = interruptedBatch([
    { name: "done.txt", status: "done" },
    { name: "active.txt", status: "running" },
    { name: "failed.pdf", status: "error", message: "cannot read" },
  ]);
  expect(rows.map((r) => r.status)).toEqual(["done", "cancelled", "error"]);
  expect(rows[2].message).toBe("cannot read");
  expect(
    interruptedEvaluation([
      { id: "done", state: "done" },
      { id: "pending", state: "queued" },
    ]).map((r) => r.state),
  ).toEqual(["done", "cancelled"]);
});
