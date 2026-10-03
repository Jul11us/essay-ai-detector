import { EXAMPLES } from "./examples";

export function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M11 7H6v26h5M29 7h5v26h-5" stroke="currentColor" strokeWidth="2.5" />
    <path d="M13 13h14M13 20h10M13 27h14" stroke="currentColor" strokeWidth="2.5" />
    <path d="M18 20h10" stroke="#7698ff" strokeWidth="6" />
  </svg>;
}

export function WorkspaceIntro() {
  return <section className="workspace-intro" aria-labelledby="intro-title">
    <div className="intro-copy">
      <p className="kicker"><span className="eyebrow-line" /> LOCAL WRITING LENS <span>本机写作复核</span></p>
      <h2 id="intro-title">先读文字，<br /><span>再看分数。</span></h2>
      <p className="lede">让每一个模型判断，回到具体的句子。<br />从整篇倾向到逐句定位，在上下文中复核你的文字。</p>
      <a className="intro-link" href="#writing-workspace">开始复核 <span aria-hidden="true">↗</span></a>
    </div>
    <div className="reading-specimen" aria-hidden="true">
      <div className="specimen-label"><span>READ BETWEEN THE LINES</span><span>01 — 03</span></div>
      <div className="specimen-sheet">
        <span className="specimen-index">01 / MANUSCRIPT</span>
        <p>每一段文字，<br />都有它的<span className="specimen-mark">上下文。</span></p>
        <div className="specimen-lines"><i /><i /><i /><i /></div>
        <div className="specimen-annotation"><span>↳</span> 分数是线索，阅读是起点</div>
      </div>
      <div className="specimen-foot"><span className="specimen-key" /> 逐句标记示意 · 非检测结果</div>
    </div>
  </section>;
}

export function ReadingGuide({ locked, onExample }: {
  locked: boolean;
  onExample: (example: (typeof EXAMPLES)[number]) => void;
}) {
  return <aside className="reading-guide" aria-label="复核指引">
    <p className="kicker">BEYOND THE SCORE</p>
    <h2>读懂结果，<br />比得到分数更重要。</h2>
    <ol className="guide-steps">
      <li><span>01</span><div><h3>从原句开始</h3><p>点击标记的句子，查看模型分数与相邻语境。</p></div></li>
      <li><span>02</span><div><h3>修改后，逐段重测</h3><p>编辑段落，自动留档，再查看版本间的文字变化。</p></div></li>
      <li><span>03</span><div><h3>把复核带走</h3><p>导出 Word 标注报告，保留当前原文和句子标记。</p></div></li>
    </ol>
    <div className="guide-examples">
      <div className="examples" role="group" aria-label="体验示例">
        <span>先用一篇示例体验</span>
        {EXAMPLES.map((example) => <button key={example.id} type="button" disabled={locked} onClick={() => onExample(example)}>{example.label}<span aria-hidden="true">↗</span></button>)}
      </div>
      <p className="example-note">示例仅用于体验操作，没有已知的人写或 AI 标签。</p>
    </div>
    <p className="local-note"><span aria-hidden="true">◈</span> 正文在本机分析<br /><small>无需把作文发送到云端</small></p>
  </aside>;
}
