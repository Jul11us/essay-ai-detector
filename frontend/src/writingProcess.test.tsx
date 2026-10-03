import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectOk, SentenceReview } from "./types";
import { appendVersion, ensureVersions, recordRecheck, snapshotResult } from "./versions";
import { appendEvent, ensureProcess, MAX_WRITING_EVENTS, recordReview } from "./writingProcess";
import { WritingTimeline } from "./WritingTimeline";

const doc = (): DetectOk => ({lang:"en",score:.2,char_count:18,model_id:"fixture",paragraphs:[{index:0,text:"Original sentence.",excerpt:"Original sentence.",score:.2,char_count:18,verdict:"low",sentences:[{text:"Original sentence.",score:.2,verdict:"low",highlight:null}]}]} as DetectOk);
const review = (note:string,state:SentenceReview["state"]="pending") => ({note,state,updated_at:new Date().toISOString()});
function annotate(data:DetectOk, value:SentenceReview|null) { return recordReview(data,{...data,paragraphs:[{...data.paragraphs[0],sentences:[{...data.paragraphs[0].sentences![0],review:value ?? undefined}]}]},"single",0,0,"Original sentence.",value); }
beforeEach(() => vi.stubGlobal("matchMedia", vi.fn(() => ({matches:false}))));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("writing process records",()=>{
  it("migrates historical timestamps honestly and remains idempotent",()=>{
    const data=appendVersion(ensureVersions(doc()),"Earlier draft","manual",true);
    delete data.writing_process;
    const restored=ensureVersions(data);
    expect(restored.writing_process!.events.map((event)=>event.created_at)).toEqual(data.version_history!.map((version)=>version.created_at));
    expect(restored.writing_process!.events.every((event)=>event.origin==="version")).toBe(true);
    expect(ensureProcess(restored)).toBe(restored);
    expect(data.writing_process).toBeUndefined();
    render(<WritingTimeline data={restored} onCompare={vi.fn()} />);
    expect(screen.getByRole("button",{name:/与前一留档对比/})).toBeInTheDocument();
  });
  it("coalesces consecutive typing, but keeps state changes, clears and intervening actions",()=>{
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const first=annotate(ensureVersions(doc()),review("A"));
    vi.advanceTimersByTime(1000); const second=annotate(first,review("A longer note"));
    expect(second.writing_process!.events).toHaveLength(2);
    expect(second.writing_process!.events[1].review).toMatchObject({note:"A longer note",updates:2});
    expect(second.writing_process!.events[1].created_at).toBe(first.writing_process!.events[1].created_at);
    expect(annotate(second,review("A longer note")).writing_process).toBe(second.writing_process);
    const changed=annotate(second,review("A longer note","reviewed"));
    const saved=appendVersion(changed,"Review checkpoint","manual",true);
    const continued=annotate(saved,review("New note","reviewed"));
    const cleared=annotate(continued,null);
    expect(cleared.writing_process!.events.map((event)=>event.kind)).toEqual(["initial","review","review","manual","review","review"]);
    expect(cleared.writing_process!.events.at(-1)!.review!.state).toBeNull();
    expect(cleared.writing_process!.events.at(-2)!.review!.note).toBe("New note");
    expect(cleared.score).toBe(.2);
    vi.advanceTimersByTime(61_000); const later=annotate(continued,review("Later note","reviewed"));
    expect(later.writing_process!.events.length).toBe(continued.writing_process!.events.length+1);
  });
  it("ignores stale sentence targets and retains the timeline across rechecks",()=>{
    const initial=ensureVersions(doc());
    expect(recordReview(initial,initial,"single",0,0,"Stale sentence",review("Wrong target"))).toBe(initial);
    const annotated=annotate(initial,review("Check the source"));
    const next=recordRecheck(annotated,{...doc(),score:.8},"第 1 段重测");
    expect(next.writing_process!.events.map((e)=>e.kind)).toEqual(["initial","review","checkpoint","recheck"]);
    expect(next.writing_process!.rechecks).toBe(1);
    expect(next.writing_process!.events.at(-1)!.comparison_base_id).toBe(next.version_history![1].id);
    expect(snapshotResult(next)).not.toHaveProperty("writing_process");
    expect(next.version_history!.every((v)=>!("writing_process" in v.result))).toBe(true);
  });
  it("bounds events separately from snapshots, retaining total counts and the origin",()=>{
    let data=ensureVersions(doc()); const origin=data.writing_process!.events[0].id;
    for(let i=0;i<210;i++) data=appendVersion(data,`draft ${i}`,"manual",true);
    expect(data.writing_process!.events).toHaveLength(MAX_WRITING_EVENTS);
    expect(data.writing_process!.total_events).toBe(211);
    expect(data.writing_process!.events[0].id).toBe(origin);
    expect(data.version_history).toHaveLength(20);
    render(<WritingTimeline data={data} onCompare={vi.fn()} />);
    fireEvent.click(screen.getByRole("button",{name:"查看更早记录"}));
    expect(screen.getByRole("button",{name:/draft 194$/})).toBeInTheDocument();
  });
  it("opens the actual before/after pair and disables replay for pruned snapshots",()=>{
    const initial=ensureVersions(doc());
    const saved=recordRecheck(initial,{...doc(),score:.8},"Changed paragraph");
    const compare=vi.fn(); const {rerender}=render(<WritingTimeline data={saved} onCompare={compare} />);
    fireEvent.click(screen.getByRole("button",{name:/查看这次修改/}));
    expect(compare).toHaveBeenCalledWith(initial.version_history![0].id,saved.version_history!.at(-1)!.id);
    rerender(<WritingTimeline data={{...saved,version_history:initial.version_history}} onCompare={compare} />);
    expect(screen.queryByRole("button",{name:/查看这次修改/})).not.toBeInTheDocument();
    expect(screen.getByText(/快照已超出保留范围/)).toBeInTheDocument();
  });
  it("shows historical notes after clearing and offers an honest empty filter",()=>{
    const note=annotate(ensureVersions(doc()),review("A preserved historical note","reviewed"));
    const cleared=annotate(note,null);
    render(<WritingTimeline data={cleared} onCompare={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("时间线记录类型"),{target:{value:"review"}});
    fireEvent.click(screen.getByRole("button",{name:/更新句子复核/}));
    expect(screen.getByText("A preserved historical note")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("时间线记录类型"),{target:{value:"restore"}});
    expect(screen.getByText("此任务还没有这类操作记录。")).toBeInTheDocument();
  });
  it("retains aggregate recheck counts after old events are pruned",()=>{
    let data=ensureVersions(doc());
    for(let i=0;i<210;i++) data=appendEvent(data,{id:`event${i}`,kind:"recheck",label:"Recheck",created_at:"2026-10-03",updated_at:"2026-10-03",origin:"action"});
    expect(data.writing_process!.rechecks).toBe(210);
    expect(data.writing_process!.events.filter((e)=>e.kind==="recheck")).toHaveLength(199);
  });
});
