import type { Unit } from "./composition";

export function sentenceDomId(lang: string, paraIndex: number, sentIndex: number): string {
  return `sent-${lang}-${paraIndex}-${sentIndex}`;
}

export function paraDomId(lang: string, paraIndex: number): string {
  return `para-${lang}-${paraIndex}`;
}

/** 滚到原文某处并闪一下。过短的段收在折叠里，先展开。 */
export function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const fold = el.closest("details");
  if (fold && !fold.open) fold.open = true;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  if (el instanceof HTMLButtonElement) el.click();
  el.classList.remove("flash");
  // 强制回流，让同一处连点两次也能重新闪一下。
  void el.offsetWidth;
  el.classList.add("flash");
}

export function unitDomId(lang: string, u: Unit): string {
  return u.sentIndex === null ? paraDomId(lang, u.paraIndex) : sentenceDomId(lang, u.paraIndex, u.sentIndex);
}
