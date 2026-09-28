import type { BilingualOk, DetectOk, Rhythm } from "./types";
import { isSectionErr } from "./types";
import { CONF_LABEL, VERDICT_LABEL, formatPercent, isShortParagraph } from "./copy";
import { suspectKey, topSuspects } from "./aggregate";
import { composition, spanPlace } from "./composition";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}

function rhythmSvg(rhythm: Rhythm): string {
  const lengths = rhythm.lengths;
  if (lengths.length < 2) return "";
  const w = 640;
  const h = 120;
  const max = Math.max(...lengths, 1);
  const points = lengths
    .map((n, i) => {
      const x = (i / (lengths.length - 1)) * (w - 16) + 8;
      const y = h - 16 - (n / max) * (h - 28);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="120" role="img" aria-label="${esc(rhythm.note)}"><polyline fill="none" stroke="#3f5c4a" stroke-width="2" points="${points}" /></svg>`;
}

function sectionHtml(data: DetectOk): string {
  const bars = data.paragraphs
    .map((p) => {
      const width = Math.max(2, Math.round(p.score * 100));
      const note = isShortParagraph(p) ? "（过短）" : "";
      return `<div class="bar-row"><span>第 ${p.index + 1} 段${note}</span><span class="track"><span class="fill ${p.verdict}" style="width:${width}%"></span></span><span>${formatPercent(p.score)}%</span></div>`;
    })
    .join("");
  const markers = data.markers?.length
    ? `<ul>${data.markers.map((m) => `<li>${esc(m.phrase)} <strong>×${m.count}</strong></li>`).join("")}</ul>`
    : "<p>清单里的典型套话，这篇一次都没出现。</p>";
  const comp = composition(data);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const strip = comp.units
    .map((u) => `<span class="seg ${u.band}" style="flex-grow:${u.weight}"></span>`)
    .join("");
  const spanList = comp.spans.length
    ? `<p>连续较高分的区段：</p><ul>${comp.spans
        .map((sp) => `<li>${esc(spanPlace(sp))}（占全文 ${pct(sp.share)}）</li>`)
        .join("")}</ul>`
    : "";
  const compoHtml = `<h2>全文分布 · ${esc(comp.label)}</h2>
    <div class="strip">${strip}</div>
    <p>较高分 ${pct(comp.ai)} · 不确定 ${pct(comp.unclear)} · 较低分 ${pct(comp.human)}（按字数）</p>
    <p>${esc(comp.detail)}</p>${spanList}`;
  const suspects = topSuspects(data);
  const topKeys = new Set(suspects.map((s) => suspectKey(s.paraIndex, s.sentIndex)));
  const suspectList = suspects.length
    ? `<h2>优先复核的句子</h2><ol class="suspects">${suspects
        .map(
          (s) =>
            `<li><strong>${formatPercent(s.score)}%</strong> · 第 ${s.paraIndex + 1} 段 · ${esc(s.text)}</li>`,
        )
        .join("")}</ol>`
    : "";
  const paras = data.paragraphs
    .map((p) => {
      const body = p.sentences?.length
        ? p.sentences
            .map((s, i) => {
              const level = topKeys.has(suspectKey(p.index, i)) ? "top" : s.highlight;
              const cls = level ? ` class="sent ${level}"` : "";
              return `<span${cls}>${esc(s.text)}</span>`;
            })
            .join(" ")
        : esc(p.text || p.excerpt);
      return `<section class="para"><h3>第 ${p.index + 1} 段 · ${formatPercent(p.score)}% · ${VERDICT_LABEL[p.verdict]}</h3><p>${body}</p></section>`;
    })
    .join("");
  const rhythm = data.rhythm
    ? `<h2>句长波动 · ${esc(data.rhythm.label)}</h2><p>${esc(data.rhythm.note)}</p>${rhythmSvg(data.rhythm)}`
    : "";
  return `
    <p class="score">模型原始分数 ${formatPercent(data.score)}% · ${VERDICT_LABEL[data.verdict]} · 文本充分度 ${CONF_LABEL[data.confidence]}</p>
    ${compoHtml}
    <p>原始分数未经本站作文样本校准，也不是 AI 所写字数比例。文本充分度只由长度和段落分数计算。</p>
    <h2>各段分布</h2>
    ${bars}
    <h2>写作特征提示</h2>
    <p>只提示，不改原文。命中只说明这些说法在大模型里很常见。</p>
    ${markers}
    ${rhythm}
    ${suspectList}
    ${data.ignored?.length ? `<h2>未参与评分的文字</h2><ul>${data.ignored.map((item) => `<li>${esc(item.reason)}：${esc(item.text)}</li>`).join("")}</ul>` : ""}
    <h2>分段正文</h2>
    <p>${suspects.length ? "红底白字是全文嫌疑最重的几句；" : ""}浅红是单句分数已到较高，浅黄是单句偏高。</p>
    ${paras}
    <h2>判定依据</h2>
    <p>${esc(data.basis || data.explanation)}</p>
    <p>${esc(data.reading || "")}</p>
    <p class="model">模型：${esc(data.model_id)}</p>
  `;
}

const STYLE = `
  body { margin: 0; color: #1c1916; background: #f6f1e8; font: 16px/1.55 "Palatino Linotype", "Songti SC", serif; }
  main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 64px; }
  h1 { font-size: 1.8rem; margin-bottom: 0.2rem; }
  h2 { font-size: 0.95rem; margin: 1.4rem 0 0.4rem; }
  .banner, .foot { background: #efe8db; border-left: 3px solid #3f5c4a; padding: 0.8rem 1rem; }
  .score { font-size: 1.4rem; }
  .bar-row { display: grid; grid-template-columns: 7rem 1fr 4rem; gap: 0.5rem; align-items: center; margin: 0.25rem 0; font-size: 0.9rem; }
  .track { background: #efe8db; height: 8px; }
  .fill { display: block; height: 8px; background: #8a7048; }
  .fill.high { background: #8a4b2f; }
  .fill.low { background: #3f5c4a; }
  .sent.mid { background: #f6e3a1; }
  .sent.high { background: #f3cfc3; }
  .sent.top { background: #c8321f; color: #fff; padding: 0 0.15em; }
  .strip { display: flex; gap: 1px; height: 16px; background: #fff; }
  .strip .seg { flex-basis: 0; min-width: 2px; }
  .seg.ai { background: #c8321f; } .seg.unclear { background: #e7c46a; } .seg.human { background: #7d9a86; }
  .strip, .seg { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sent { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .suspects { padding-left: 1.3rem; border-left: 3px solid #c8321f; }
  .suspects li { margin: 0.3rem 0; }
  .suspects strong { color: #a3261a; }
  .para { margin: 0.8rem 0; }
  ul { padding-left: 1.1rem; }
  @media print { body { background: #fff; } .banner, .foot { break-inside: avoid; } }
`;

export function buildReportHtml(data: DetectOk, generatedAt = ""): string {
  const when = generatedAt || new Date().toLocaleString();
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>作文模型检测报告</title><style>${STYLE}</style></head><body><main>
    <div class="banner"><strong>本机作文模型检测报告</strong><br>不是学校、期刊或知网出具的文件。${esc(data.disclaimer)}</div>
    <p>导出时间：${esc(when)} · 语言：${data.lang === "zh" ? "中文" : "英文"}</p>
    ${sectionHtml(data)}
    <p class="foot">${esc(data.disclaimer)} 正文只在导出这份报告的电脑上推理过。</p>
  </main></body></html>`;
}

export function buildBilingualReport(data: BilingualOk, generatedAt = ""): string {
  const when = generatedAt || new Date().toLocaleString();
  const block = (title: string, part: BilingualOk["en"]) => {
    if (!part) return `<h2>${title}</h2><p>这一部分是空的。</p>`;
    if (isSectionErr(part)) return `<h2>${title}</h2><p>${esc(part.message)}</p>`;
    return `<h2>${title}</h2>${sectionHtml(part)}`;
  };
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>作文模型检测报告</title><style>${STYLE}</style></head><body><main>
    <div class="banner"><strong>本机作文模型检测报告 · 中英分开</strong><br>不是学校、期刊或知网出具的文件。${esc(data.disclaimer)}</div>
    <p>导出时间：${esc(when)}</p>
    <p>${esc(data.note)}</p>
    ${block("英文部分", data.en)}
    ${block("中文部分", data.zh)}
    <p class="foot">${esc(data.disclaimer)}</p>
  </main></body></html>`;
}

export function downloadReport(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function printReport(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "打印报告");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();
  window.setTimeout(() => iframe.remove(), 1000);
}
