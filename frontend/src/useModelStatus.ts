import { useEffect, useState } from "react";
import { fetchStatus } from "./api";
import type { Status } from "./types";

// 模型加载期间的状态轮询间隔。
const STATUS_POLL_MS = 2000;

export function useModelStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);

  // 只在后端还在加载模型时轮询。`loading` 一变成 false，`models` 就是最终结果
  // （中英文都就绪，或某个确实失败了），再每 2 秒问下去没有意义。
  // 连不上后端时保持重试——那通常只是服务还没启动。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const pull = async () => {
      let next: Status;
      let unreachable = false;
      try {
        next = await fetchStatus();
      } catch {
        unreachable = true;
        next = {
          phase: "error",
          detail: "无法连接检测服务，请确认后端已在 8000 端口启动。",
          models: { zh: false, en: false },
          loading: false,
        };
      }
      if (cancelled) return;
      setStatus(next);
      if (unreachable || next.loading) {
        timer = window.setTimeout(pull, STATUS_POLL_MS);
      }
    };

    pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return status;
}
