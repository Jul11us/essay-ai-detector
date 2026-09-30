#!/usr/bin/env bash
# macOS / Linux 下同时启动后端(8000)和前端(5173)，Ctrl-C 一起停掉。
# 需要先按 docs/local-development.md 装好依赖并下载模型。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv-detector/bin/python}"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3)"

cleanup() { kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$ROOT/backend" && "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8000) &
BACKEND_PID=$!
(cd "$ROOT/frontend" && { [ -d node_modules ] || npm ci; } && npm run dev -- --host 127.0.0.1) &
FRONTEND_PID=$!

echo "打开 http://127.0.0.1:5173 ，等页面显示模型可用再检测。"
wait
