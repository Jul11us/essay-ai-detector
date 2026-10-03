import type { FilePreview } from "./api";
import type { DetectionScope } from "./types";

export function ScopeSelector({ preview, selection, locked, onChange }: { preview: FilePreview; selection?: number[]; locked: boolean; onChange: (indices: number[]) => void }) {
  const blocks = preview.blocks || [];
  if (!blocks.length) return preview.scope_available === false ? <p className="fine">文档过大，无法逐段选择范围。请拆成较小的文档后再上传。</p> : null;
  const chosen = selection ?? blocks.map((b) => b.index);
  const chosenSet = new Set(chosen);
  const characters = blocks.filter((b) => chosenSet.has(b.index)).reduce((n, b) => n + b.char_count, 0);
  return <details className="scope-selector">
    <summary>选择检测范围 · 已选 {chosen.length} / {blocks.length} 段</summary>
    <p>按章节快速选择，再逐段核对。章节提示依据文档中的独立标题；没有标题的内容归入正文。</p>
    <div className="scope-actions">
      <button type="button" disabled={locked} onClick={() => onChange(blocks.filter((b) => b.section === "正文").map((b) => b.index))}>仅正文</button>
      <button type="button" disabled={locked} onClick={() => onChange(blocks.filter((b) => ["正文", "摘要"].includes(b.section)).map((b) => b.index))}>正文与摘要</button>
      <button type="button" disabled={locked} onClick={() => onChange(blocks.map((b) => b.index))}>全选段落</button>
      <button type="button" disabled={locked} onClick={() => onChange([])}>清空选择</button>
    </div>
    <ul className="scope-blocks">{blocks.map((block) => <li key={block.index}>
      <label><input type="checkbox" checked={chosenSet.has(block.index)} disabled={locked} aria-label={`检测提取第 ${block.index + 1} 段`} onChange={(e) => onChange(e.target.checked ? [...chosen, block.index].sort((a, b) => a - b) : chosen.filter((i) => i !== block.index))} />
        <span><strong>第 {block.index + 1} 段 · {block.section}</strong><small>{block.char_count} 字符</small></span></label>
      <p>{block.text.length > 180 ? block.text.slice(0, 180) + "…" : block.text}</p>
      {block.text.length > 180 && <details><summary>查看完整段落</summary><p>{block.text}</p></details>}
    </li>)}</ul>
    <p className="scope-count" role="status">本次选中 {characters.toLocaleString()} 个非空白字符；排除 {blocks.length - chosen.length} 段。标题、过短段落及参考文献仍按检测规则排除。</p>
    {!chosen.length && <p role="alert" className="fail">至少选择一段需要检测的文字。</p>}
  </details>;
}

export function ScopeSummary({ scope }: { scope: DetectionScope }) {
  return <details className="scope-summary"><summary>实际检测范围：{scope.selected_blocks} / {scope.total_blocks} 个提取段落</summary>
    <p>{scope.source_name} · 选中 {scope.selected_chars.toLocaleString()} / {scope.total_chars.toLocaleString()} 个非空白字符。</p>
    <p>{scope.note}</p>
    {!!scope.excluded.length && <div><strong>用户排除的文字</strong>{scope.excluded.map((item, i) => <div key={i}><span>{item.reason}</span><p>{item.text}</p></div>)}</div>}
  </details>;
}
