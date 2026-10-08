import { useCallback, useEffect, useRef, useState } from "react";
import { clearTasks, loadTasks, MAX_SAVED_TASKS, putTask, removeTask, type NewTask, type SavedTask } from "./tasks";

export function useTaskLibrary() {
  const [tasks, setTasks] = useState<SavedTask[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const current = useRef<SavedTask[]>([]);
  const deleted = useRef(new Set<string>());
  const update = useCallback((task: SavedTask) => {
    if (deleted.current.has(task.id)) return;
    current.current = [task, ...current.current.filter((t) => t.id !== task.id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    setTasks(current.current);
  }, []);
  useEffect(() => {
    let live = true;
    void loadTasks().then((saved) => {
      if (!live) return;
      const existing = new Map(saved.map((task) => [task.id, task]));
      for (const task of current.current) existing.set(task.id, task);
      current.current = [...existing.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); setTasks(current.current);
    }).catch(() => { if (live) setError("本机任务记录读取失败。本页可以继续检测，但当前无法确认恢复记录。"); })
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);
  const create = useCallback(async (payload: NewTask, files: File[], title: string): Promise<SavedTask> => {
    if (current.current.length >= MAX_SAVED_TASKS) throw new Error("已保存 50 个任务，请先在任务中心删除不需要的任务。");
    const now = new Date().toISOString();
    const task: SavedTask = { ...payload, schema: 1, id: crypto.randomUUID(), title, created_at: now, updated_at: now, state: "queued", file_names: files.map((f) => f.name) };
    update(task);
    setPending((n) => n + 1);
    try { await putTask(task, files); setError(""); }
    catch { setError("本机任务保存失败。本次可继续检测，但刷新后可能无法恢复输入与最新结果，请先导出需要的报告。"); }
    finally { setPending((n) => n - 1); }
    return task;
  }, [update]);
  const save = useCallback((task: SavedTask) => {
    if (deleted.current.has(task.id)) return;
    const snapshot = { ...task, updated_at: new Date().toISOString() };
    update(snapshot);
    setPending((n) => n + 1);
    return putTask(snapshot).catch(() => setError("任务进度未能保存。刷新前请保留需要的结果或导出报告。"))
      .finally(() => setPending((n) => n - 1));
  }, [update]);
  const remove = useCallback(async (id: string) => {
    try {
      await removeTask(id); deleted.current.add(id);
      current.current = current.current.filter((t) => t.id !== id); setTasks(current.current);
      setError("");
      return true;
    } catch { setError("删除未完成，请重试；本机记录可能仍然存在。"); return false; }
  }, []);
  const removeAll = useCallback(async () => {
    try {
      await clearTasks();
      for (const task of current.current) deleted.current.add(task.id);
      current.current = []; setTasks([]);
      setError("");
      return true;
    } catch { setError("清空未完成，请重试；本机记录可能仍然存在。"); return false; }
  }, []);
  const get = useCallback((id: string) => current.current.find((t) => t.id === id), []);
  const rename = useCallback(async (id: string, title: string) => {
    const original = current.current.find((t) => t.id === id);
    const trimmed = title.trim();
    if (!original || deleted.current.has(id)) throw new Error("这份任务已不存在。");
    if (!trimmed || trimmed.length > 120) throw new Error("任务名称需要 1–120 个字符。");
    const next = { ...original, title: trimmed, updated_at: new Date().toISOString() };
    update(next); setPending((n) => n + 1);
    try { await putTask(next); }
    catch {
      const latest = current.current.find((t) => t.id === id);
      if (latest?.title === trimmed) {
        const restored = { ...latest, title: original.title };
        update(restored);
        // A queued progress save may contain the optimistic name; restore the
        // title after it while retaining that save's result and progress.
        await putTask(restored).catch(() => undefined);
      }
      setError("任务名称未能保存，请重试。");
      throw new Error("任务名称未能保存，请重试。");
    } finally { setPending((n) => n - 1); }
  }, [update]);
  return { tasks, ready, error, pending, create, save, remove, removeAll, get, rename };
}

export type TaskLibrary = ReturnType<typeof useTaskLibrary>;
