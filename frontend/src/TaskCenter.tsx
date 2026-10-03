import { useState } from "react";
import type { SavedTask } from "./tasks";

const KINDS = { single: "单篇检测", batch: "批量检测", evaluation: "样本评测" };
export function taskProgress(task: SavedTask, active: boolean) {
  const total = task.kind === "single" ? 1 : task.kind === "batch" ? task.file_names.length : task.samples.length;
  const done = task.kind === "single" ? Number(Boolean(task.result)) : task.kind === "batch" ? task.rows.filter((r) => r.status === "done").length : task.records.length;
  const state = active ? "running" : done === total && task.state === "complete" ? "complete" : task.state === "failed" ? "failed" : "paused";
  return { total, done, state };
}
const STATES: Record<string, string> = { running: "正在运行", complete: "已完成", failed: "检测失败", paused: "可继续" };
export function TaskCenter({ tasks, ready, error, pending, activeIds, locked, onOpen, onStop, onDelete, onRename }: {
  tasks: SavedTask[]; ready: boolean; error: string; pending: number; activeIds: string[]; locked: boolean;
  onOpen: (task: SavedTask) => Promise<void>; onStop: (task: SavedTask) => void; onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [localError, setLocalError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("updated");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [savingName, setSavingName] = useState(false);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = tasks.filter((t) => (!needle || [t.title, ...t.file_names].some((value) => value.toLocaleLowerCase().includes(needle)))
    && (kind === "all" || t.kind === kind) && (status === "all" || taskProgress(t, activeIds.includes(t.id)).state === status))
    .sort((a,b) => sort === "name" ? a.title.localeCompare(b.title, "zh-CN") : sort === "created" ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at));
  return <section className="task-center" aria-labelledby="task-center-title">
    <header className="evaluation-heading"><p className="kicker">LOCAL TASKS</p><h2 id="task-center-title">把每一次复核，接着做完。</h2><p>搜索一份原稿，或回到上次停下的地方。</p></header>
    <div className="task-toolbar">
      <label className="task-search">搜索任务<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="任务名称或原文件名" /></label>
      <label>任务类型<select aria-label="任务类型" value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">全部类型</option>{Object.entries(KINDS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>任务状态<select aria-label="任务状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option>{Object.entries(STATES).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>任务排序<select aria-label="任务排序" value={sort} onChange={(e) => setSort(e.target.value)}><option value="updated">最近更新</option><option value="created">最近创建</option><option value="name">名称顺序</option></select></label>
    </div>
    <div className="task-list-caption"><span>{filtered.length} / {tasks.length} 个任务</span>{ready && !!tasks.length && !error && <span role="status">{pending ? "正在保存任务进度…" : "已保存到本机"}</span>}</div>
    {(error || localError) && <p role="alert" className="fail">{localError || error}</p>}
    {!ready && <p role="status">正在读取本机任务…</p>}
    {ready && !tasks.length && <div className="evaluation-empty"><h3>等待你的第一份任务</h3><p>开始单篇检测、批量检测或样本评测后，进度会出现在这里。</p></div>}
    {ready && !!tasks.length && !filtered.length && <div className="evaluation-empty"><h3>没有匹配的任务</h3><p>试试原文件名，或放宽筛选条件。</p><button type="button" className="text-btn" onClick={() => { setQuery(""); setKind("all"); setStatus("all"); }}>清除筛选</button></div>}
    <ul className="task-list">{filtered.map((task) => {
      const active = activeIds.includes(task.id);
      const {total,done,state} = taskProgress(task,active);
      return <li className="task-item" key={task.id}>
        <div className="task-item-main">
          <div className="task-item-heading"><span className="task-kind">{KINDS[task.kind]}</span><span className={`task-state ${active ? "running" : state}`}>{STATES[state]}</span></div>
          {renaming === task.id ? <form className="task-rename" onSubmit={async (e) => { e.preventDefault(); setSavingName(true); setLocalError(""); try { await onRename(task.id,title); setRenaming(null); } catch(e) { setLocalError(e instanceof Error ? e.message : "重命名失败"); } finally { setSavingName(false); } }}>
            <label>任务名称<input autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if(e.key === "Escape" && !savingName) setRenaming(null); }} /></label>
            <button type="submit" disabled={savingName || !title.trim()}>保存名称</button><button type="button" disabled={savingName} onClick={() => setRenaming(null)}>取消重命名</button>
          </form> : <h3>{task.title}</h3>}
          {!!task.file_names.length && <p className="task-files" title={task.file_names.join("、")}>{task.file_names.join("、")}</p>}
          <p className="task-meta">{done} / {total} 份完成 · {new Date(task.updated_at).toLocaleString("zh-CN")}</p>
          <progress max={Math.max(1,total)} value={done} aria-label={`${task.title}任务进度`} />
          {task.kind === "single" && task.message && <p className="fine">{task.message}</p>}
        </div>
        <div className="task-actions">
          <button type="button" className="eval-primary" disabled={locked || opening !== null || savingName} onClick={async () => {
            setOpening(task.id); setLocalError("");
            try { await onOpen(task); } catch(e) { setLocalError(e instanceof Error ? e.message : "任务恢复失败"); } finally { setOpening(null); }
          }}>{opening === task.id ? "正在恢复…" : state === "complete" ? "打开结果" : "打开并继续"}</button>
          {active && <button type="button" className="text-btn" onClick={() => onStop(task)}>{task.kind === "batch" ? "取消后续文件" : "停止任务"}</button>}
          {!active && <><button type="button" className="text-btn" disabled={locked || opening !== null || savingName} onClick={() => { setRenaming(task.id); setTitle(task.title); }}>重命名</button><button type="button" className="text-btn" disabled={locked || opening !== null || savingName} onClick={() => setConfirming(task.id)}>删除任务</button></>}
        </div>
        {confirming === task.id && <div className="task-delete-confirm"><p>删除这份任务的原文件、结果、版本与批注？已下载的报告会保留。</p><button type="button" onClick={async () => { await onDelete(task.id); setConfirming(null); }}>确认删除</button><button type="button" onClick={() => setConfirming(null)}>保留任务</button></div>}
      </li>;
    })}</ul>
    <p className="task-storage-note">原文、文件、版本和批注保存在这个浏览器中，最多 50 个任务。刷新后手动继续；清除网站数据会清除记录。</p>
  </section>;
}
