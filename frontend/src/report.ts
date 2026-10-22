import type { BilingualOk, DetectOk, Rhythm } from "./types";
import { isSectionErr } from "./types";
import {
  AI_RATE_LABEL,
  AI_RATE_NOTE,
  CONF_LABEL,
  VERDICT_LABEL,
  formatPercent,
  isShortParagraph,
} from "./copy";
import { suspectKey, topSuspects } from "./aggregate";
import { composition, spanPlace } from "./composition";
import { downloadText } from "./download";
import { REVIEW_LABEL } from "./reviews";

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
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="120" role="img" aria-label="${esc(rhythm.note)}"><polyline fill="none" stroke="#244bd8" stroke-width="2" points="${points}" /></svg>`;
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
      const notes = (p.sentences || [])
        .filter((s) => s.review)
        .map(
          (s) =>
            `<blockquote><strong>人工复核：${REVIEW_LABEL[s.review!.state]}</strong><p>${esc(s.text)}</p><p>${esc(s.review!.note || "未填写备注")}</p></blockquote>`,
        )
        .join("");
      return `<section class="para"><h3>第 ${p.index + 1} 段 · ${formatPercent(p.score)}% · ${VERDICT_LABEL[p.verdict]}</h3><p>${body}</p>${notes}</section>`;
    })
    .join("");
  const rhythm = data.rhythm
    ? `<h2>句长波动 · ${esc(data.rhythm.label)}</h2><p>${esc(data.rhythm.note)}</p>${rhythmSvg(data.rhythm)}`
    : "";
  return `
    <p class="score">${AI_RATE_LABEL} ${formatPercent(data.score)}% · ${VERDICT_LABEL[data.verdict]} · 文本充分度 ${CONF_LABEL[data.confidence]}</p>
    <p>${AI_RATE_NOTE}</p>
    ${data.detection_scope ? `<h2>实际检测范围</h2><p>${esc(data.detection_scope.source_name)}：选中 ${data.detection_scope.selected_blocks} / ${data.detection_scope.total_blocks} 段，${data.detection_scope.selected_chars} / ${data.detection_scope.total_chars} 个非空白字符。</p><p>${esc(data.detection_scope.note)}</p>${data.detection_scope.excluded.map((item) => `<details><summary>${esc(item.reason)}</summary><p>${esc(item.text)}</p></details>`).join("")}` : ""}
    ${compoHtml}
    <p>文本充分度只由长度和段落分数计算。</p>
    <h2>各段分布</h2>
    ${bars}
    <h2>写作特征提示</h2>
    <p>这些是清单中的可观察用语，可能同时出现在人写和 AI 文本中；命中次数不解释模型分数。</p>
    ${markers}
    ${rhythm}
    ${suspectList}
    ${data.ignored?.length ? `<h2>未参与评分的文字</h2><ul>${data.ignored.map((item) => `<li>${esc(item.reason)}：${esc(item.text)}</li>`).join("")}</ul>` : ""}
    <h2>分段正文</h2>
    <p>${suspects.length ? "带红色下划线的句子是本次模型分数最高的几句；" : ""}浅红和浅黄对应不同的模型分数档位。请结合上下文复核。</p>
    ${paras}
    <h2>判定依据</h2>
    <p>${esc(data.basis || data.explanation)}</p>
    <p>${esc(data.reading || "")}</p>
    <p class="model">模型：${esc(data.model_id)}</p>
    ${data.calibration ? `<h2>整篇阈值与评测范围</h2><p>${esc(data.calibration.note)}</p>` : ""}
    ${data.calibration?.counts?.test ? `<p>独立测试：人写 ${data.calibration.counts.test.human} 篇，AI ${data.calibration.counts.test.ai} 篇，混合 ${data.calibration.counts.test.mixed} 篇。</p>` : ""}
  `;
}

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; color: #18243b; background: #f3f5f8; font: 14px/1.8 "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { width: min(820px, calc(100% - 32px)); margin: 32px auto; padding: 36px; background: #fff; border: 1px solid #dce2ec; }
  h1 { font-size: 1.8rem; margin-bottom: 0.2rem; }
  h2 { font-size: 1rem; color: #244bd8; margin: 2rem 0 0.8rem; padding-top: 1rem; border-top: 1px solid #dce2ec; }
  h3 { font: 12px "Segoe UI", "Microsoft YaHei", sans-serif; color: #596579; }
  .banner, .foot { background: #f1f4ff; border-left: 2px solid #244bd8; padding: 1rem 1.2rem; font-size: 12px; }
  .score { font-size: 1.45rem; font-weight: 600; padding: 1.2rem 0; }
  .bar-row { display: grid; grid-template-columns: 7rem 1fr 4rem; gap: 0.5rem; align-items: center; margin: 0.25rem 0; font-size: 0.9rem; }
  .track { background: #e8ecf3; height: 6px; }
  .fill { display: block; height: 6px; background: #c1a266; }
  .fill.high { background: #c87869; }
  .fill.low { background: #6b9c89; }
  .sent.mid { background: #fff0cc; }
  .sent.high { background: #fbe4e0; }
  .sent.top { background: #f8d8d3; color: #7a2424; text-decoration: underline #c5766d; text-underline-offset: 4px; }
  .strip { display: flex; gap: 1px; height: 16px; background: #fff; }
  .strip .seg { flex-basis: 0; min-width: 2px; }
  .seg.ai { background: #e8b1a6; } .seg.unclear { background: #efd395; } .seg.human { background: #9dcbb5; }
  .strip, .seg { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sent { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .suspects { padding-left: 1.3rem; border-left: 2px solid #c87869; }
  .suspects li { margin: 0.3rem 0; }
  .suspects strong { color: #a33835; }
  .para { margin: 1.5rem 0; }
  .para p { font: 16px/1.95 "Georgia", "Songti SC", "SimSun", serif; white-space: pre-wrap; overflow-wrap: anywhere; }
  .model { overflow-wrap: anywhere; font-size: 12px; color: #596579; }
  ul { padding-left: 1.1rem; }
  @media (max-width: 560px) { main { margin: 16px auto; padding: 20px; } .bar-row { grid-template-columns: 5rem 1fr 3rem; font-size: 12px; } }
  @media print { body { background: #fff; } main { width: 100%; margin: 0; padding: 0; border: 0; } h2, h3 { break-after: avoid; } .banner, .foot { break-inside: avoid; } }
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
  downloadText(html, filename, "text/html");
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
