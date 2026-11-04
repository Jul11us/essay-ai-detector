import { useEffect, useRef, useState } from "react";
import { suspectKey } from "./aggregate";
import { VERDICT_LABEL, formatPercent } from "./copy";
import { paraDomId, sentenceDomId } from "./domIds";
import type { ParagraphHit } from "./types";
import type { ReviewTarget } from "./ReviewSidebar";
import { REVIEW_LABEL } from "./reviews";

function sentenceClass(highlight: string | null, top: boolean): string | undefined {
  if (top) return "sent top";
  return highlight ? `sent ${highlight}` : undefined;
}

function ParagraphBody({
  para,
  lang,
  topKeys,
  selected,
  onSelect,
}: {
  para: ParagraphHit;
  lang: string;
  topKeys: Set<string>;
  selected?: ReviewTarget | null;
  onSelect?: (target: ReviewTarget) => void;
}) {
  const sentences = (para.sentences ?? [])
    .map((sentence, index) => ({ sentence, index }))
    .filter(({ sentence }) => sentence.text);
  if (!sentences.length) return <p className="body">{para.text || para.excerpt}</p>;
  return (
    <p className="body">
      {sentences.map(({ sentence, index }, order) => {
        const top = topKeys.has(suspectKey(para.index, index));
        const active =
          selected?.para === para.index &&
          selected.sentence === index &&
          selected.text === sentence.text;
        return (
          <span key={index}>
            {order > 0 ? " " : ""}
            {sentence.score == null ? (
              <span id={sentenceDomId(lang, para.index, index)}>{sentence.text}</span>
            ) : (
              <button
                type="button"
                id={sentenceDomId(lang, para.index, index)}
                className={`sent-button ${sentenceClass(sentence.highlight, top) || "sent"} ${active ? "selected" : ""}`}
                title={`查看本句模型分数：${formatPercent(sentence.score)}%`}
                aria-label={`${sentence.text}（第 ${para.index + 1} 段第 ${index + 1} 句，模型分数 ${formatPercent(sentence.score)}%，点击查看说明）`}
                aria-expanded={active}
                aria-controls={active ? `sentence-detail-${lang}-${para.index}` : undefined}
                onClick={() =>
                  onSelect?.({ para: para.index, sentence: index, text: sentence.text })
                }
              >
                {sentence.text}
                {sentence.review && (
                  <span
                    className={`sentence-review-badge ${sentence.review.state}`}
                    aria-label={`人工复核：${REVIEW_LABEL[sentence.review.state]}`}
                  >
                    {" "}
                    · {REVIEW_LABEL[sentence.review.state]}
                  </span>
                )}
              </button>
            )}
          </span>
        );
      })}
    </p>
  );
}

export function Para({
  para,
  lang,
  topKeys,
  locked,
  rechecking,
  onRecheck,
  onScan,
  selected,
  onSelect,
}: {
  para: ParagraphHit;
  lang: string;
  topKeys: Set<string>;
  locked: boolean;
  rechecking: boolean;
  onRecheck: (index: number, text: string) => Promise<string | null>;
  onScan: (index: number) => Promise<void>;
  selected?: ReviewTarget | null;
  onSelect?: (target: ReviewTarget) => void;
}) {
  const [editing, setEditing] = useState(false);
  const editField = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [draft, setDraft] = useState(para.text || para.excerpt);
  const [localError, setLocalError] = useState<string | null>(null);
  const located = (para.sentences ?? []).some((s) => s.score != null);
  // undefined 表示还在排队或正在跑；null / [] 是被跳过或失败了，给个按钮手动再来。
  const canLocate = !located && para.sentences !== undefined;

  useEffect(() => {
    setDraft(para.text || para.excerpt);
  }, [para.text, para.excerpt, para.score]);
  useEffect(() => {
    if (editing) editField.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  async function submit() {
    setLocalError(null);
    const message = await onRecheck(para.index, draft);
    if (message) {
      setLocalError(message);
      return;
    }
    setEditing(false);
  }

  return (
    <li id={paraDomId(lang, para.index)} className={`para ${para.verdict}`}>
      <header>
        <span>第 {para.index + 1} 段</span>
        <strong>
          {formatPercent(para.score)}% · {VERDICT_LABEL[para.verdict]}
        </strong>
      </header>
      {editing ? (
        <textarea
          ref={editField}
          className="para-edit"
          value={draft}
          aria-label={`修改第 ${para.index + 1} 段`}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
        />
      ) : (
        <ParagraphBody
          para={para}
          lang={lang}
          topKeys={topKeys}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      {para.sentenceNote && <p className="fine">{para.sentenceNote}</p>}
      <div className="para-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="text-btn"
              disabled={locked || rechecking}
              onClick={submit}
            >
              {rechecking ? "正在重测这一段…" : "重测这一段"}
            </button>
            <button
              type="button"
              className="text-btn"
              disabled={rechecking}
              onClick={() => {
                setDraft(para.text || para.excerpt);
                setEditing(false);
                setLocalError(null);
              }}
            >
              取消修改
            </button>
          </>
        ) : (
          <button
            ref={editButton}
            type="button"
            className="text-btn"
            disabled={locked || rechecking}
            onClick={() => setEditing(true)}
          >
            在此修改并重测本段
          </button>
        )}
        {canLocate && (
          <button
            type="button"
            className="text-btn"
            disabled={locked || rechecking}
            onClick={() => onScan(para.index)}
          >
            定位本段句子
          </button>
        )}
      </div>
      {localError && <p className="fail">{localError}</p>}
    </li>
  );
}
