# 本地开发与验证

本页是开发人员的运行说明。产品状态与评分限制请先看 [README](../README.md) 和 [评测说明](benchmark.md)。

## 目录与入口

- `打开.bat`、`停止.bat` 是 Windows 日常入口；`open.bat`、`stop.bat` 是英文别名。
- `scripts/open.ps1`、`scripts/stop.ps1` 实际启动和停止后端与前端。
- 后端 API 默认在 `http://127.0.0.1:8000`，前端开发界面默认在 `http://127.0.0.1:5173`。
- `experiments/models/`、`experiments/benchmark-private/`、`.venv-detector/`、`frontend/node_modules/` 均留在本机，不提交到 Git。

## 首次准备

在项目根目录的 PowerShell 执行：

```powershell
py -3 -m venv .venv-detector
.\.venv-detector\Scripts\python.exe -m pip install -r backend\requirements.txt
npm --prefix frontend ci
.\.venv-detector\Scripts\python.exe experiments\download_model.py
.\打开.bat
```

macOS / Linux 可用 `scripts/dev.sh` 一键启动前后端（Ctrl-C 停止），虚拟环境放在 `.venv-detector/` 或用 `PYTHON` 环境变量指定解释器。

要跑测试，把上面的 `requirements.txt` 换成 `backend\requirements-dev.txt`（多装 pytest 和 httpx）。

英文模型默认放在 `experiments/models/vanguard`，也可用 `VANGUARD_MODEL_PATH` 指定。中文模型由后端首次加载时下载。只关闭浏览器并不会停止模型服务；请用 `停止.bat`。

## 测试

```powershell
Push-Location backend
..\.venv-detector\Scripts\python.exe -m pytest -q
Pop-Location
npm --prefix frontend run lint
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

默认的后端测试不加载模型，GitHub Actions（`.github/workflows/ci.yml`）在每次推送和 PR 时跑后端 pytest 与前端测试、构建。安装好中英文权重后，可在 `backend` 目录执行 `..\.venv-detector\Scripts\python.exe -m pytest -q -m golden` 检查固定**合成样本**的分数是否漂移。基线文件由 `backend/golden.py` 生成；它用于回归检查，不是准确率评测。

端到端冒烟测试用真实的前端和 FastAPI 接口，只把模型换成确定性的假打分（`backend/e2e_server.py`），所以不需要权重：

```powershell
npm --prefix frontend run e2e
```

首次运行先执行 `npx playwright install chromium`。用 `E2E_PYTHON` 指定装好后端依赖的 Python，`PW_CHROMIUM_PATH` 指定已有的 Chromium。本地如果 8000 或 5173 端口已经有服务，测试会直接复用它们；在本机跑之前先 `停止.bat`，以免连到真实模型。

CPU 可选 ONNX INT8 路径：先安装 `backend/requirements-onnx.txt`，再运行 `experiments/export_onnx.py`。没有导出文件时后端继续使用 PyTorch。

## 设计背景

第一版的设计说明保留在 [design/initial-spec.md](design/initial-spec.md)，其中写了模型选择、英文推理预算和错误文案的由来。它是历史文档，部分内容（例如“不做 PDF”）已经过时，文件顶部有说明。
