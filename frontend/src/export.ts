import type { Outcome } from "./aggregate";
import { downloadText } from "./download";
import type { BilingualOk, DetectOk } from "./types";
import { isBilingual, isSectionErr } from "./types";

type Cell = string | number | null | undefined;

// 电子表格会把以这些字符开头的单元格当公式执行，作文原文里很可能出现（破折号、@ 提及）。
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const RESULT_HEADER = [
  "language",
  "paragraph",
  "sentence",
  "score",
  "paragraph_score",
  "verdict",
  "highlight",
  "text",
];

const prob = (n: number) => Number(n.toFixed(4));

/** 逐句定位跑完的段每句一行；还没有句子分数的段退回整段一行。序号从 1 开始。 */
function resultRows(data: DetectOk): Cell[][] {
  const rows: Cell[][] = [];
  for (const p of data.paragraphs) {
    const sentences = (p.sentences ?? []).filter((s) => s.text);
    if (!sentences.length) {
      rows.push([data.lang, p.index + 1, "", prob(p.score), prob(p.score), p.verdict, "", p.text || p.excerpt]);
      continue;
    }
    sentences.forEach((s, i) => {
      rows.push([
        data.lang,
        p.index + 1,
        i + 1,
        s.score == null ? "" : prob(s.score),
        prob(p.score),
        s.verdict ?? "",
        s.highlight ?? "",
        s.text,
      ]);
    });
  }
  return rows;
}

export function buildResultCsv(data: DetectOk): string {
  return toCsv([RESULT_HEADER, ...resultRows(data)]);
}

export function buildBilingualCsv(data: BilingualOk): string {
  const rows: Cell[][] = [];
  for (const part of [data.en, data.zh]) {
    if (part && !isSectionErr(part)) rows.push(...resultRows(part));
  }
  return toCsv([RESULT_HEADER, ...rows]);
}

export function buildResultJson(data: Outcome, exportedAt = new Date().toISOString()): string {
  return JSON.stringify({ schema: 1, exported_at: exportedAt, result: data }, null, 2);
}

// Excel 打开没有 BOM 的 UTF-8 CSV 会把中文显示成乱码。
export function downloadCsv(csv: string, filename: string): void {
  downloadText("﻿" + csv, filename, "text/csv");
}

export function downloadJson(json: string, filename: string): void {
  downloadText(json, filename, "application/json");
}

export function exportCsvFor(data: Outcome): string {
  return isBilingual(data) ? buildBilingualCsv(data) : buildResultCsv(data);
}
