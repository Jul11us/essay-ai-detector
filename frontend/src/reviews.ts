import type { SentenceHit, SentenceReview } from "./types";

export const REVIEW_LABEL = { reviewed: "已复核", pending: "待确认", revise: "需修改" };
export function keepReviews(previous: SentenceHit[], incoming: SentenceHit[]): SentenceHit[] {
  const reviews = new Map<string, (SentenceReview | undefined)[]>();
  for (const sentence of previous)
    reviews.set(sentence.text, [...(reviews.get(sentence.text) || []), sentence.review]);
  return incoming.map((sentence) => ({ ...sentence, review: reviews.get(sentence.text)?.shift() }));
}
