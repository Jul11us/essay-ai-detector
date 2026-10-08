import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskCenter } from "./TaskCenter";
import type { SavedTask } from "./tasks";

const base={schema:1 as const,created_at:"2026-10-01T10:00:00Z",updated_at:"2026-10-02T10:00:00Z"};
const tasks:SavedTask[]=[
  {...base,id:"one",title:"引用核对",file_names:["Original-paper.txt"],kind:"single",state:"complete",input:{lang:"en",text:"",en:"",zh:""},preview:null,result:{lang:"en",score:.4,paragraphs:[]} as never},
  {...base,id:"two",title:"课堂作业",file_names:["a.txt","b.txt"],kind:"batch",state:"running",rows:[]},
  {...base,id:"three",title:"样本检查",file_names:["samples.json"],kind:"evaluation",state:"paused",samples:[],rows:[],records:[],bundle:null},
];
function props() { return {tasks,ready:true,error:"",pending:0,activeIds:["two"],locked:false,onOpen:vi.fn(async()=>{}),onStop:vi.fn(),onDelete:vi.fn(async()=>{}),onClearAll:vi.fn(async()=>{}),onRename:vi.fn(async()=>{})}; }
describe("task management",() => {
  it("combines case-insensitive original filename search with type and live status filters",() => {
    render(<TaskCenter {...props()} />);
    fireEvent.change(screen.getByLabelText("搜索任务"),{target:{value:"  ORIGINAL-PAPER  "}});
    expect(screen.getByRole("heading",{name:"引用核对"})).toBeInTheDocument();
    expect(screen.queryByRole("heading",{name:"课堂作业"})).toBeNull();
    fireEvent.change(screen.getByLabelText("任务类型"),{target:{value:"batch"}});
    expect(screen.getByText("没有匹配的任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"清除筛选"}));
    fireEvent.change(screen.getByLabelText("任务状态"),{target:{value:"running"}});
    expect(screen.getByRole("heading",{name:"课堂作业"})).toBeInTheDocument();
    expect(screen.queryByRole("heading",{name:"引用核对"})).toBeNull();
  });
  it("submits a trimmed name through the library and exposes storage errors",async() => {
    const p=props(); p.onRename.mockRejectedValueOnce(new Error("存储不可用"));
    render(<TaskCenter {...p} />);
    const row=screen.getByRole("heading",{name:"引用核对"}).closest("li")!;
    await userEvent.click(within(row).getByRole("button",{name:"重命名"}));
    fireEvent.change(screen.getByLabelText("任务名称"),{target:{value:"第二稿"}});
    await userEvent.click(screen.getByRole("button",{name:"保存名称"}));
    expect(p.onRename).toHaveBeenCalledWith("one","第二稿");
    expect(await screen.findByRole("alert")).toHaveTextContent("存储不可用");
    expect(screen.getByLabelText("任务名称")).toHaveValue("第二稿");
  });
  it("keeps searching available while a run is locked and preserves explicit delete confirmation",async() => {
    const p=props(); const {rerender}=render(<TaskCenter {...p} locked />);
    expect(screen.getByLabelText("搜索任务")).toBeEnabled();
    const row=screen.getByRole("heading",{name:"引用核对"}).closest("li")!;
    expect(within(row).getByRole("button",{name:"删除任务"})).toBeDisabled();
    rerender(<TaskCenter {...p} />);
    await userEvent.click(within(row).getByRole("button",{name:"删除任务"}));
    expect(p.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button",{name:"确认删除"}));
    expect(p.onDelete).toHaveBeenCalledWith("one");
  });
  it("clears every task only after an explicit confirmation, and says how many",async() => {
    const p={...props(),activeIds:[] as string[]};
    render(<TaskCenter {...p} />);
    await userEvent.click(screen.getByRole("button",{name:"清空全部本机任务"}));
    expect(p.onClearAll).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("清空全部 3 个任务");
    await userEvent.click(screen.getByRole("button",{name:"保留任务"}));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(p.onClearAll).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button",{name:"清空全部本机任务"}));
    await userEvent.click(screen.getByRole("button",{name:"确认清空"}));
    expect(p.onClearAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("clears all tasks even when a filter hides some of them",async() => {
    const p={...props(),activeIds:[] as string[]};
    render(<TaskCenter {...p} />);
    fireEvent.change(screen.getByLabelText("任务类型"),{target:{value:"batch"}});
    await userEvent.click(screen.getByRole("button",{name:"清空全部本机任务"}));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("清空全部 3 个任务");
  });
  it("will not clear while a task is running or the workspace is locked",() => {
    const {rerender}=render(<TaskCenter {...props()} />);
    expect(screen.getByRole("button",{name:"清空全部本机任务"})).toBeDisabled();
    expect(screen.getByText("有任务正在运行，结束或停止后才能清空。")).toBeInTheDocument();
    rerender(<TaskCenter {...props()} activeIds={[]} locked />);
    expect(screen.getByRole("button",{name:"清空全部本机任务"})).toBeDisabled();
  });
  it("keeps the confirmation open and shows the reason when clearing fails",async() => {
    const p={...props(),activeIds:[] as string[]}; p.onClearAll.mockRejectedValueOnce(new Error("存储不可用"));
    render(<TaskCenter {...p} />);
    await userEvent.click(screen.getByRole("button",{name:"清空全部本机任务"}));
    await userEvent.click(screen.getByRole("button",{name:"确认清空"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("存储不可用");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
  it("offers no clear button when there is nothing to clear",() => {
    render(<TaskCenter {...props()} tasks={[]} />);
    expect(screen.queryByRole("button",{name:"清空全部本机任务"})).toBeNull();
  });
});
