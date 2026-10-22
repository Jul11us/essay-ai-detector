import { useRef, useState } from "react";
import type { Outcome } from "./aggregate";
import type { DetectOk } from "./types";
import { isBilingual, isSectionErr } from "./types";
import { Compare } from "./Compare";
import { WritingTimeline } from "./WritingTimeline";

function section(result: Outcome, lang: "en" | "zh"): DetectOk | null {
  if (!isBilingual(result)) return result.lang === lang ? result : null;
  const part = result[lang];
  return part && !isSectionErr(part) ? part : null;
}
export function VersionPanel({
  data,
  locked,
  onSave,
  onRestore,
}: {
  data: Outcome;
  locked: boolean;
  onSave: (label: string) => void;
  onRestore: (id: string) => void;
}) {
  const history = data.version_history || [];
  const [left, setLeft] = useState(history[0]?.id || "current");
  const [right, setRight] = useState("current");
  const [lang, setLang] = useState<"en" | "zh">(data.lang === "zh" ? "zh" : "en");
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const comparisonRef = useRef<HTMLDivElement>(null);
  const a = history.find((v) => v.id === left)?.result || data;
  const b = history.find((v) => v.id === right)?.result || data;
  const before = section(a, lang),
    after = section(b, lang);
  const options = (
    <>
      <option value="current">当前结果 · 含最新批注</option>
      {history.map((v, i) => (
        <option value={v.id} key={`${v.id}:${i}`}>
          {i + 1}. {v.label} · {new Date(v.created_at).toLocaleString("zh-CN")}
        </option>
      ))}
    </>
  );
  return (
    <details className="version-panel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span>
          <span className="result-kicker">WRITING HISTORY</span>
          <strong>写作过程与版本对比</strong>
        </span>
        <span>
          {data.writing_process?.events.length || 0} 条记录 · {history.length} 个版本
        </span>
      </summary>
      {open && (
        <div className="version-panel-body">
          <WritingTimeline
            data={data}
            onCompare={(a, b) => {
              setLeft(a);
              setRight(b);
              requestAnimationFrame(() => {
                comparisonRef.current?.scrollIntoView({
                  block: "start",
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                    ? "instant"
                    : "smooth",
                });
                comparisonRef.current?.focus({ preventScroll: true });
              });
            }}
          />
          <div className="version-comparison-heading" ref={comparisonRef} tabIndex={-1}>
            <span className="result-kicker">VERSION COMPARISON</span>
            <h3>回看文字如何变化</h3>
          </div>
          <form
            className="version-save"
            onSubmit={(e) => {
              e.preventDefault();
              onSave(label);
              setLabel("");
              setNotice("版本已加入任务记录。");
            }}
          >
            <label>
              版本名称
              <input
                value={label}
                maxLength={80}
                placeholder="例如：核对引用后的第二稿"
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <button type="submit" className="eval-primary" disabled={locked}>
              保存当前版本
            </button>
          </form>
          <p className="fine">
            每次段落重测自动留档。保留初始版本和最近 19 次记录，随任务保存到本机；Word
            报告导出当前结果。
          </p>
          <div className="version-selectors">
            <label>
              左侧版本
              <select
                aria-label="左侧版本"
                value={history.some((v) => v.id === left) ? left : "current"}
                onChange={(e) => setLeft(e.target.value)}
              >
                {options}
              </select>
            </label>
            <label>
              右侧版本
              <select
                aria-label="右侧版本"
                value={history.some((v) => v.id === right) ? right : "current"}
                onChange={(e) => setRight(e.target.value)}
              >
                {options}
              </select>
            </label>
            {isBilingual(data) && (
              <label>
                对比语言
                <select
                  aria-label="对比语言"
                  value={lang}
                  onChange={(e) => setLang(e.target.value as "en" | "zh")}
                >
                  <option value="en">英文</option>
                  <option value="zh">中文</option>
                </select>
              </label>
            )}
          </div>
          <div className="version-restore">
            <p className="fine">查看旧版本不会改变正文。恢复时会保留当前复核记录。</p>
            <button
              type="button"
              className="text-btn"
              disabled={locked || right === "current" || !history.some((v) => v.id === right)}
              onClick={() => {
                onRestore(right);
                setRight("current");
                setNotice("已恢复所选版本，并保留恢复前的记录。");
              }}
            >
              恢复右侧版本
            </button>
          </div>
          {notice && (
            <p role="status" className="fine">
              {notice}
            </p>
          )}
          {before && after ? (
            <Compare before={before} after={after} />
          ) : (
            <p className="fine">所选版本没有这一语言的有效检测结果。</p>
          )}
        </div>
      )}
    </details>
  );
}
