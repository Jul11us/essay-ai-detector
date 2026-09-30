import { useEffect, useState } from "react";
import { suspectKey } from "./aggregate";
import { VERDICT_LABEL, formatPercent } from "./copy";
import { paraDomId, sentenceDomId } from "./domIds";
import type { ParagraphHit } from "./types";

function sentenceClass(highlight: string | null, top: boolean): string | undefined {
  if (top) return "sent top";
  return highlight ? `sent ${highlight}` : undefined;
}

function ParagraphBody({
  para,
  lang,
  topKeys,
}: {
  para: ParagraphHit;
  lang: string;
  topKeys: Set<string>;
}) {
  // 保留原下标：「嫌疑最重」按 sentences 数组里的位置记，过滤掉空句会错位。
  const [selected, setSelected] = useState<number | null>(null);
  const sentences = (para.sentences ?? [])
    .map((sentence, index) => ({ sentence, index }))
    .filter(({ sentence }) => sentence.text);
  if (!sentences.length) {
    return <p className="body">{para.text || para.excerpt}</p>;
  }
  const selectedSentence = selected === null ? null : para.sentences?.[selected] ?? null;
  return (
    <div>
      <p className="body">
        {sentences.map(({ sentence, index }, order) => {
          const top = topKeys.has(suspectKey(para.index, index));
          const content = sentence.score == null ? (
            <span id={sentenceDomId(lang, para.index, index)}>{sentence.text}</span>
          ) : (
            <button
              type="button"
              id={sentenceDomId(lang, para.index, index)}
              className={`sent-button ${sentenceClass(sentence.highlight, top) || "sent"}`}
              title={`查看本句模型分数：${formatPercent(sentence.score)}%`}
              aria-label={`${sentence.text}（第 ${para.index + 1} 段第 ${index + 1} 句，模型分数 ${formatPercent(sentence.score)}%，点击查看说明）`}
              onClick={() => setSelected(index)}
            >
              {sentence.text}
            </button>
          );
          return <span key={index}>{order > 0 ? " " : ""}{content}</span>;
        })}
      </p>
      {selectedSentence?.score != null && (
        <div className="sentence-detail" role="status">
          <strong>第 {para.index + 1} 段第 {selected! + 1} 句 · 模型分数 {formatPercent(selectedSentence.score)}%</strong>
          <p>单句与相邻句上下文各检测一次，取两者较低分。请连同前后句阅读。</p>
          {selectedSentence.observations?.length
            ? <p>可观察的套话：{selectedSentence.observations.map((item) => item.phrase).join("、")}。这不是分数的因果解释，也不是 AI 写作证据。</p>
            : <p>本句未命中本站的套话清单；这不能解释分数高低。</p>}
        </div>
      )}
    </div>
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
}: {
  para: ParagraphHit;
  lang: string;
  topKeys: Set<string>;
  locked: boolean;
  rechecking: boolean;
  onRecheck: (index: number, text: string) => Promise<string | null>;
  onScan: (index: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(para.text || para.excerpt);
  const [localError, setLocalError] = useState<string | null>(null);
  const located = (para.sentences ?? []).some((s) => s.score != null);
  // undefined 表示还在排队或正在跑；null / [] 是被跳过或失败了，给个按钮手动再来。
  const canLocate = !located && para.sentences !== undefined;

  useEffect(() => {
    setDraft(para.text || para.excerpt);
  }, [para.text, para.excerpt, para.score]);

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
          className="para-edit"
          value={draft}
          aria-label={`修改第 ${para.index + 1} 段`}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
        />
      ) : (
        <ParagraphBody para={para} lang={lang} topKeys={topKeys} />
      )}
      {para.sentenceNote && <p className="fine">{para.sentenceNote}</p>}
      <div className="para-actions">
        {editing ? (
          <>
            <button type="button" className="text-btn" disabled={locked || rechecking} onClick={submit}>
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
