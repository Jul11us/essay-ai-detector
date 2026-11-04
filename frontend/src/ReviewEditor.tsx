import { useEffect, useRef, useState } from "react";
import { REVIEW_LABEL } from "./reviews";
import type { SentenceReview } from "./types";

export function ReviewEditor({
  review,
  onSave,
}: {
  review?: SentenceReview;
  onSave: (review: SentenceReview | null) => void;
}) {
  const [state, setState] = useState<SentenceReview["state"]>(review?.state ?? "pending");
  const [note, setNote] = useState(review?.note ?? "");
  const [saved, setSaved] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const draft = useRef({ state, note });
  const current = useRef<SentenceReview | null>(review ?? null);
  const history = useRef<(SentenceReview | null)[]>([]);
  const saveCallback = useRef(onSave);
  saveCallback.current = onSave;
  function commit() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    history.current = [...history.current.slice(-9), current.current];
    const next = { ...draft.current, updated_at: new Date().toISOString() };
    current.current = next;
    saveCallback.current(next);
    setSaved(true);
    setUndoCount(history.current.length);
  }
  function change(next: typeof draft.current) {
    draft.current = next;
    dirty.current = true;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, 500);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current)
        saveCallback.current({ ...draft.current, updated_at: new Date().toISOString() });
    },
    [],
  );
  return (
    <div
      className="review-editor"
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) commit();
      }}
    >
      <div className="review-editor-heading">
        <strong>人工复核</strong>
        <span>自动保存 · 随报告导出</span>
      </div>
      <label>
        复核状态
        <select
          aria-label="人工复核状态"
          value={state}
          onChange={(e) => {
            const value = e.target.value as SentenceReview["state"];
            setState(value);
            change({ ...draft.current, state: value });
          }}
        >
          {Object.entries(REVIEW_LABEL).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        你的批注
        <textarea
          aria-label="人工复核批注"
          value={note}
          maxLength={2000}
          rows={4}
          placeholder="记录上下文、引用依据或需要核对的问题…"
          onChange={(e) => {
            setNote(e.target.value);
            change({ ...draft.current, note: e.target.value });
          }}
        />
      </label>
      <div className="review-editor-actions">
        <button
          type="button"
          className="eval-primary"
          onClick={() => {
            dirty.current = true;
            commit();
          }}
        >
          保存批注
        </button>
        <button
          type="button"
          className="text-btn"
          disabled={!undoCount && !dirty.current}
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            const previous = dirty.current ? current.current : (history.current.pop() ?? null);
            dirty.current = false;
            current.current = previous;
            draft.current = { state: previous?.state ?? "pending", note: previous?.note ?? "" };
            setState(draft.current.state);
            setNote(draft.current.note);
            saveCallback.current(previous);
            setUndoCount(history.current.length);
            setSaved(true);
          }}
        >
          撤销批注
        </button>
        {current.current && (
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              timer.current = null;
              dirty.current = false;
              history.current = [...history.current.slice(-9), current.current];
              current.current = null;
              draft.current = { state: "pending", note: "" };
              setState("pending");
              setNote("");
              saveCallback.current(null);
              setUndoCount(history.current.length);
              setSaved(true);
            }}
          >
            清除批注
          </button>
        )}
        <span role="status">
          {saved ? "已保存" : dirty.current ? "正在保存…" : "编辑后自动保存"}
        </span>
      </div>
      <p className="fine">
        批注不改变模型分数。离开这句也会保存；本次打开可撤销最近 10
        次保存。清除当前批注后，时间线中的历史记录仍保留。
      </p>
    </div>
  );
}
