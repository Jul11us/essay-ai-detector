import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTaskLibrary } from "./useTaskLibrary";
import { loadTasks, putTask } from "./tasks";
import type { SingleTask } from "./tasks";
vi.mock("./tasks",async(importOriginal) => ({...await importOriginal<typeof import("./tasks")>(),loadTasks:vi.fn(),putTask:vi.fn()}));
const task = {schema:1,id:"fixture",title:"Original",kind:"single",state:"complete",file_names:["original.txt"],created_at:"now",updated_at:"now",result:{score:.2}} as SingleTask;
describe("task rename persistence",() => {
  it("retains input and original file metadata and stores the trimmed title",async() => {
    vi.mocked(loadTasks).mockResolvedValue([task]); vi.mocked(putTask).mockResolvedValue();
    const {result}=renderHook(useTaskLibrary); await waitFor(()=>expect(result.current.ready).toBe(true));
    await act(async()=>{await result.current.rename(task.id,"  Revised  ");});
    expect(result.current.get(task.id)?.title).toBe("Revised");
    expect(putTask).toHaveBeenLastCalledWith(expect.objectContaining({file_names:["original.txt"],result:task.result,title:"Revised"}));
  });
  it("rolls back a failed name while retaining concurrent progress updates",async() => {
    vi.mocked(loadTasks).mockResolvedValue([task]);
    let reject!:(reason:Error)=>void;
    vi.mocked(putTask).mockImplementationOnce(()=>new Promise<void>((_,fail)=>{reject=fail;})).mockResolvedValue();
    const {result}=renderHook(useTaskLibrary); await waitFor(()=>expect(result.current.ready).toBe(true));
    let naming!:Promise<void>; act(()=>{naming=result.current.rename(task.id,"New name");});
    act(()=>{void result.current.save({...result.current.get(task.id)!,result:{...task.result,score:.8}} as SingleTask);});
    await act(async()=>{reject(new Error("quota")); await expect(naming).rejects.toThrow("未能保存");});
    expect(result.current.get(task.id)?.title).toBe("Original");
    expect(result.current.get(task.id)).toMatchObject({result:{score:.8}});
    expect(putTask).toHaveBeenLastCalledWith(expect.objectContaining({title:"Original",result:expect.objectContaining({score:.8})}));
  });
});
