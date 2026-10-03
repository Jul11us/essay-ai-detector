import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { alignParagraphs, appendVersion, diffText, ensureVersions, recordRecheck, snapshotResult } from "./versions";
import { Compare } from "./Compare";
import type { BilingualOk, DetectOk } from "./types";

const doc = (texts:string[],score=.7):DetectOk => ({lang:"en",score,model_id:"fixture",model_revision:"v1",paragraphs:texts.map((text,index) => ({index,text,excerpt:text,score,verdict:"high",char_count:text.length}))} as DetectOk);
describe("version records",() => {
  it("snapshots text, scope and reviews without recursively copying histories",() => {
    const original = doc(["Original."]);
    original.detection_scope = {source_name:"paper.txt",selected_blocks:1} as DetectOk["detection_scope"];
    original.paragraphs[0].sentences = [{text:"Original.",score:.6,verdict:"high",highlight:"high",review:{state:"reviewed",note:"Keep it.",updated_at:"now"}}];
    const saved = ensureVersions(original);
    original.paragraphs[0].text = "Changed.";
    expect((saved.version_history![0].result as DetectOk).paragraphs[0].text).toBe("Original.");
    const snap = snapshotResult(saved) as DetectOk;
    expect(snap.version_history).toBeUndefined();
    expect(snap.paragraphs[0].sentences![0].review?.note).toBe("Keep it.");
    expect(snap.detection_scope?.source_name).toBe("paper.txt");
  });
  it("keeps the initial version and most recent nineteen records",() => {
    let result = ensureVersions(doc(["Initial"]));
    const first = result.version_history![0].id;
    for(let i=0;i<30;i++) result = appendVersion({...result,score:i/100},`draft ${i}`,"manual",true);
    expect(result.version_history).toHaveLength(20);
    expect(result.version_history![0].id).toBe(first);
    expect(result.version_history![1].label).toBe("draft 11");
    expect(new Set(result.version_history!.map((v) => v.id)).size).toBe(20);
  });
  it("captures the latest review before a recheck and keeps bilingual snapshots separate",() => {
    const initial = ensureVersions({lang:"bi",en:doc(["Old"]),zh:{...doc(["中文"]),lang:"zh"},note:"",disclaimer:""});
    const withReview = structuredClone(initial) as BilingualOk;
    const en = withReview.en as DetectOk;
    en.paragraphs[0].sentences = [{text:"Old",score:.2,verdict:"low",highlight:null,review:{state:"revise",note:"Verify",updated_at:"now"}}];
    const result = recordRecheck(withReview,{...withReview,en:doc(["New"],.1)},"English recheck") as BilingualOk;
    expect(result.version_history).toHaveLength(3);
    expect(((result.version_history![1].result as BilingualOk).en as DetectOk).paragraphs[0].sentences![0].review?.note).toBe("Verify");
    expect((result.zh as DetectOk).paragraphs[0].text).toBe("中文");
    expect((snapshotResult({...result,en:ensureVersions(en)}) as BilingualOk).en).not.toHaveProperty("version_history");
  });
});
describe("text and paragraph comparison",() => {
  it.each([["你好，world!\n", "您好，beautiful world!\n"],["<script>😺 café", "<style>😸 café"],["", "new\r\ntext"],["deleted text",""]])("reconstructs both exact Unicode texts",(a,b) => {
    const diff = diffText(a,b);
    expect(diff.chunks.filter((c) => c.kind!=="add").map((c) => c.text).join("")).toBe(a);
    expect(diff.chunks.filter((c) => c.kind!=="remove").map((c) => c.text).join("")).toBe(b);
  });
  it("bounds a long rewrite and retains unchanged prefix and suffix",() => {
    const a="prefix "+"甲".repeat(1500)+" suffix", b="prefix "+"乙".repeat(1500)+" suffix";
    const diff=diffText(a,b);
    expect(diff.granular).toBe(false);
    expect(diff.chunks[0]).toEqual({kind:"same",text:"prefix "});
    expect(diff.chunks.at(-1)).toEqual({kind:"same",text:" suffix"});
    expect(diff.chunks.filter((c) => c.kind!=="add").map((c) => c.text).join("")).toBe(a);
  });
  it("aligns unchanged paragraphs after insertion instead of matching index numbers",() => {
    const a=doc(["One original lake paragraph.","Second original mountain paragraph."]);
    const b=doc(["A completely new introduction.",...a.paragraphs.map((p) => p.text!)]);
    const pairs=alignParagraphs(a,b);
    expect(pairs[0].before).toBeUndefined();
    expect(pairs[1].before?.index).toBe(0); expect(pairs[1].after?.index).toBe(1);
    expect(pairs[2].before?.index).toBe(1); expect(pairs[2].after?.index).toBe(2);
  });
  it("shows deleted paragraphs and both parts of a split",() => {
    const a=doc(["A preserved apple paragraph.","A removed orange paragraph.","Our family walked by the lake and returned home."]);
    const b=doc(["A preserved apple paragraph.","Our family walked by the lake.","We returned home."]);
    const pairs=alignParagraphs(a,b);
    expect(pairs.some((p) => p.before?.index===1 && !p.after)).toBe(true);
    expect(pairs.flatMap((p) => p.after ? [p.after.index] : [])).toEqual([0,1,2]);
  });
  it("compares changed text even when model scores are identical and safely escapes markup",() => {
    render(<Compare before={doc(["<script> old text"])} after={doc(["<script> new text"])} />);
    expect(document.querySelector("del")?.textContent).toContain("old");
    expect(document.querySelector("ins")?.textContent).toContain("new");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("0.0 个百分点")).toBeInTheDocument();
  });
  it("shows a signed decrease and warns when the model revision changes",() => {
    const {rerender}=render(<Compare before={doc(["Old"],.9)} after={doc(["New"],.2)} />);
    expect(screen.getByText("-70.0 个百分点")).toBeInTheDocument();
    rerender(<Compare before={doc(["Old"])} after={{...doc(["New"]),model_revision:"v2"}} />);
    expect(screen.getByText("模型不同")).toBeInTheDocument();
    expect(screen.queryByText("0.0 个百分点")).toBeNull();
  });
});
