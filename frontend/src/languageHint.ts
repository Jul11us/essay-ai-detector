import type { Lang } from "./types";

// Input aid only. The backend still validates language before inference.
export function suggestLanguage(text: string): Lang | null {
  const sample = text.slice(0, 6000);
  const han = (sample.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (han >= 20 && latin >= 40 && Math.min(han, latin) / Math.max(han, latin) >= 0.16) return "bi";
  if (han >= 12 && han > latin * 0.4) return "zh";
  if (latin >= 40 && latin > han * 2) return "en";
  return null;
}

export const LANGUAGE_LABEL: Record<Lang, string> = {
  zh: "中文",
  en: "英文",
  bi: "中英分开",
};
