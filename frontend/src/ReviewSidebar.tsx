import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatPercent } from "./copy";
import { sentenceDomId } from "./domIds";
import { ReviewEditor } from "./ReviewEditor";
import type { DetectOk, SentenceHit, SentenceReview } from "./types";

export type ReviewTarget = { para: number; sentence: number; text: string };
export type ReviewItem = ReviewTarget & { hit: SentenceHit };
export function reviewItems(data: DetectOk): ReviewItem[] {
  return data.paragraphs.flatMap((p) =>
    (p.sentences || []).flatMap((s, i) =>
      s.text && s.score != null ? [{ para: p.index, sentence: i, text: s.text, hit: s }] : [],
    ),
  );
}
export const needsReview = (item: ReviewItem) =>
  !item.hit.review || item.hit.review.state === "pending";

export function ReviewSidebar({
  data,
  selected,
  onSelect,
  onClose,
  onReview,
}: {
  data: DetectOk;
  selected: ReviewTarget;
  onSelect: (target: ReviewTarget) => void;
  onClose: () => void;
  onReview?: (para: number, sentence: number, text: string, review: SentenceReview | null) => void;
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.("(max-width: 800px)").matches ?? false,
  );
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const items = reviewItems(data);
  const index = items.findIndex(
    (item) =>
      item.para === selected.para &&
      item.sentence === selected.sentence &&
      item.text === selected.text,
  );
  const item = items[index];
  const context = data.paragraphs.flatMap((p) =>
    (p.sentences || []).flatMap((s, i) =>
      s.text ? [{ para: p.index, sentence: i, text: s.text }] : [],
    ),
  );
  const contextIndex = context.findIndex(
    (c) => c.para === selected.para && c.sentence === selected.sentence && c.text === selected.text,
  );
  const pending = items.filter(needsReview);
  const nextPending = [...items.slice(index + 1), ...items.slice(0, index)].find(needsReview);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(max-width: 800px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.body.style.overflow;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    close.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previous;
      if (root) root.inert = wasInert ?? false;
    };
  }, [mobile]);
  useEffect(() => {
    const scroller = mobile
      ? panel.current
      : panel.current?.closest<HTMLElement>(".analysis-sidebar");
    if (scroller) scroller.scrollTop = 0;
  }, [selected.para, selected.sentence, selected.text, mobile]);
  // Keyboard navigation stays in the review pane; manuscript geometry is unchanged.
  const content = (
    <div
      ref={panel}
      id={`sentence-detail-${data.lang}-${selected.para}`}
      className={`sentence-detail review-sidebar ${mobile ? "review-drawer" : ""}`}
      role={mobile ? "dialog" : "region"}
      aria-modal={mobile || undefined}
      aria-label="句子复核"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (mobile && e.key === "Tab") {
          const controls = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]),textarea,select,input,summary,[tabindex="0"]',
            ) || [],
          );
          const first = controls[0],
            last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="review-sidebar-header">
        <div>
          <p className="result-kicker">READ & REVIEW</p>
          <h3>句子复核</h3>
        </div>
        <button type="button" ref={close} className="text-btn" onClick={onClose}>
          收起句子说明
        </button>
      </div>
      {item && (
        <>
          <div className="review-position">
            <span>
              第 {item.para + 1} 段 · 第 {item.sentence + 1} 句
            </span>
            <strong>
              {formatPercent(item.hit.score!)}% <small>模型估计</small>
            </strong>
          </div>
          <div className="review-context">
            {context[contextIndex - 1] && (
              <p className="context-neighbor">
                <span>前一句</span>
                {context[contextIndex - 1].text}
              </p>
            )}
            <blockquote>{item.text}</blockquote>
            {context[contextIndex + 1] && (
              <p className="context-neighbor">
                <span>后一句</span>
                {context[contextIndex + 1].text}
              </p>
            )}
          </div>
          <div className="review-navigation">
            <button type="button" disabled={index <= 0} onClick={() => onSelect(items[index - 1])}>
              上一句
            </button>
            <span>
              {index + 1} / {items.length}
            </span>
            <button
              type="button"
              disabled={index >= items.length - 1}
              onClick={() => onSelect(items[index + 1])}
            >
              下一句
            </button>
          </div>
          <button
            type="button"
            className="review-next-pending"
            disabled={!nextPending}
            onClick={() => {
              if (nextPending) onSelect(nextPending);
            }}
          >
            下一条待确认 <span>{pending.length} 句待确认</span>
          </button>
          {onReview && (
            <ReviewEditor
              key={`${item.para}:${item.sentence}:${item.text}`}
              review={item.hit.review}
              onSave={(review) => onReview(item.para, item.sentence, item.text, review)}
            />
          )}
          <details className="review-score-note">
            <summary>这个单句分数如何得到</summary>
            <p>单句与相邻句上下文各检测一次，取两者较低分。请连同前后句阅读。</p>
            <p>
              {item.hit.observations?.length
                ? `可观察的套话：${item.hit.observations.map((o) => o.phrase).join("、")}。这不是分数的因果解释，也不是 AI 写作证据。`
                : "本句未命中本站的套话清单；这不能解释分数高低。"}
            </p>
          </details>
        </>
      )}
    </div>
  );
  return mobile
    ? createPortal(
        <div
          className="review-drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {content}
        </div>,
        document.body,
      )
    : content;
}
export function focusSentence(lang: string, target: ReviewTarget) {
  document
    .getElementById(sentenceDomId(lang, target.para, target.sentence))
    ?.focus({ preventScroll: true });
}
