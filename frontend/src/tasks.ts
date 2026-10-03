import type { Outcome } from "./aggregate";
import type { FilePreview } from "./api";
import type { BatchRow } from "./batch";
import type { EvaluationBundle, EvaluationRecord, Sample } from "./evaluation";
import type { DetectInput } from "./useDetector";

export type RunRow = { id: string; state: "queued" | "running" | "done" | "error" | "cancelled"; message?: string };
export type TaskBase = { schema: 1; id: string; title: string; created_at: string; updated_at: string; state: "queued" | "running" | "paused" | "complete" | "failed"; file_names: string[] };
export type SingleTask = TaskBase & { kind: "single"; input: Omit<DetectInput, "file">; preview: FilePreview | null; result: Outcome | null; message?: string };
export type BatchTask = TaskBase & { kind: "batch"; rows: BatchRow[] };
export type EvaluationTask = TaskBase & { kind: "evaluation"; samples: Sample[]; rows: RunRow[]; records: EvaluationRecord[]; bundle: EvaluationBundle | null };
export type SavedTask = SingleTask | BatchTask | EvaluationTask;
export type NewTask = { kind: "single"; input: SingleTask["input"]; preview: FilePreview | null; result: Outcome | null }
  | { kind: "batch"; rows: BatchRow[] }
  | { kind: "evaluation"; samples: Sample[]; rows: RunRow[]; records: EvaluationRecord[]; bundle: EvaluationBundle | null };

const DATABASE = "writing-lens-tasks";
export const MAX_SAVED_TASKS = 50;
type StoredFile = { name: string; type: string; lastModified: number; relativePath: string; blob: Blob };
let database: Promise<IDBDatabase> | undefined;
let writes: Promise<unknown> = Promise.resolve();
const removed = new Set<string>();

function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("浏览器不支持本机任务保存。本页仍可检测，但刷新后无法恢复。"));
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("tasks", { keyPath: "id" }); request.result.createObjectStore("files"); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error("任务保存被另一个页面阻塞，请关闭旧页面后重试。"));
  });
  return database;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation, operation);
  writes = next.catch(() => undefined);
  return next;
}

async function write(task: SavedTask, files?: File[]) {
  if (removed.has(task.id)) return;
  const connection = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = connection.transaction(files ? ["tasks", "files"] : ["tasks"], "readwrite");
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error("本机保存失败"));
    tx.objectStore("tasks").put(task);
    if (files) tx.objectStore("files").put(files.map((file): StoredFile => ({ name: file.name, type: file.type, lastModified: file.lastModified, relativePath: file.webkitRelativePath, blob: file })), task.id);
  });
}

export function putTask(task: SavedTask, files?: File[]): Promise<void> {
  // Snapshot before entering the queue; evaluation records can change while a
  // previous IndexedDB transaction is still committing.
  const snapshot = JSON.parse(JSON.stringify(task)) as SavedTask;
  const originals = files ? [...files] : undefined;
  return serialize(() => write(snapshot, originals));
}
export function removeTask(id: string): Promise<void> {
  return serialize(async () => {
    const connection = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction(["tasks", "files"], "readwrite");
      tx.objectStore("tasks").delete(id); tx.objectStore("files").delete(id);
      tx.oncomplete = () => { removed.add(id); resolve(); }; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  });
}

function read<T>(store: string, key?: string): Promise<T> {
  return db().then((connection) => new Promise<T>((resolve, reject) => {
    const request = key === undefined ? connection.transaction(store).objectStore(store).getAll() : connection.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }));
}

export async function loadTasks(): Promise<SavedTask[]> {
  if (typeof indexedDB === "undefined") return [];
  const records = await read<unknown[]>("tasks");
  return records.filter((r): r is SavedTask => {
    if (!r || typeof r !== "object") return false;
    const task = r as SavedTask;
    return task.schema === 1 && typeof task.id === "string" && typeof task.title === "string" && Array.isArray(task.file_names)
      && ["single", "batch", "evaluation"].includes(task.kind) && ["queued", "running", "paused", "complete", "failed"].includes(task.state)
      && typeof task.updated_at === "string" && Number.isFinite(Date.parse(task.updated_at))
      && task.file_names.every((name) => typeof name === "string")
      && (task.kind === "single" ? !!task.input && ["en", "zh", "bi", null].includes(task.input.lang) && [task.input.text, task.input.en, task.input.zh].every((text) => typeof text === "string")
        : Array.isArray(task.rows) && (task.kind !== "evaluation" || Array.isArray(task.samples) && Array.isArray(task.records)));
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function loadTaskFiles(task: SavedTask): Promise<File[]> {
  await writes;
  const stored = await read<StoredFile[] | undefined>("files", task.id);
  if (!stored || stored.length !== task.file_names.length || stored.some((f, i) => f.name !== task.file_names[i] || !(f.blob instanceof Blob))) throw new Error("任务原文件没有成功保存，无法继续。请重新选择文件；已保存的结果仍可查看。");
  return stored.map((f) => {
    const file = new File([f.blob], f.name, { type: f.type, lastModified: f.lastModified });
    if (f.relativePath) Object.defineProperty(file, "webkitRelativePath", { value: f.relativePath });
    return file;
  });
}

export function interruptedBatch(rows: BatchRow[]): BatchRow[] {
  return rows.map((row) => row.status === "running" || row.status === "queued" ? { ...row, status: "cancelled", message: "页面中断，等待继续检测。" } : row);
}
export function interruptedEvaluation(rows: RunRow[]): RunRow[] {
  return rows.map((row) => row.state === "running" || row.state === "queued" ? { ...row, state: "cancelled", message: "页面中断，等待继续评测。" } : row);
}

export async function withTaskLock<T>(id: string | null, run: () => Promise<T>): Promise<T> {
  if (!id || !navigator.locks) return run();
  return navigator.locks.request(`writing-lens:${id}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("这个任务正在其他页面运行，请等待完成后再继续。");
    return run();
  });
}
