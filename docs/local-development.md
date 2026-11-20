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

英文模型默认放在 `experiments/models/vanguard`，也可用 `VANGUARD_MODEL_PATH` 指定。中文模型由后端首次加载时下载，可用 `ZH_MODEL_PATH` 指向同一版本的离线副本。两个模型都固定上游提交并核对权重、配置和分词文件；不匹配不会加载。升级时重新安装依赖并运行 `experiments/download_model.py`，它会替换不匹配的英文文件。中文缓存损坏时，移除损坏的模型缓存并重启，或指定完整的离线副本。只关闭浏览器并不会停止模型服务；请用 `停止.bat`。

评分复现应使用相同的模型版本、锁定的推理依赖和运行方式。可选的 ONNX、GPU 和不同硬件不保证逐位相同。`/api/status` 会报告实际运行方式及评分版本。中文输入恢复 BERT 首尾标记后，旧中文校准配置不再适用，需重跑评测。英文评分方式不变。

### 可选英文第二模型复核（默认关闭）

先下载约 501 MB 的 MIT 模型，再设置开关并**重启后端**。不会自动下载，也不加入 CI 默认模型下载：

```powershell
.\.venv-detector\Scripts\python.exe experiments\download_model.py --en-review
$env:DETECTOR_EN_REVIEW = "1"
.\打开.bat
```

macOS / Linux 用 `.venv-detector/bin/python experiments/download_model.py --en-review` 下载，然后 `DETECTOR_EN_REVIEW=1 scripts/dev.sh` 启动。默认路径为 `experiments/models/openai-detector`，下载和加载均可用 `EN_REVIEW_MODEL_PATH` 指定同一离线目录。固定模型为 [openai-community/roberta-base-openai-detector](https://huggingface.co/openai-community/roberta-base-openai-detector/tree/6cba99c003b711c7fe94f8a3aa2be35a792cb6fa)，提交与 SHA256 在 `backend/app/model_artifacts.py`，加载只读本地文件。模型卡声明 MIT，完整上游 [MIT 许可证](https://github.com/openai/gpt-2-output-dataset/blob/b76f67c651fea691b37abe01a6de762bc43330e7/LICENSE) 需随再分发保留。

`/api/status` 的 `en_review.state` 为 `disabled`、`loading`、`ready` 或 `unavailable`；第二模型独立加载，不影响中英文就绪状态。缺文件、校验失败或加载/推理失败时退回原 Vanguard 输出，不新增响应字段。取消开关（PowerShell：`Remove-Item Env:DETECTOR_EN_REVIEW`；Linux/macOS：取消设置或设为 `0`）后重启即恢复默认。

此功能仅用于 `lang=en` 的整篇检测，不用于中英分开模式、段落重测或逐句接口。只在最终 Vanguard 档位为 `low` 时读取参与评分正文的前 512 token；第二模型的 `Fake` 类（下标 0）概率 ≥`0.2915322184562683` 才把整篇升为 `uncertain`，永不生成 `high`，不修改 Vanguard 分数、充分度或段落分数。成功复核时响应含 `second_opinion_score` 和布尔标记 `paraphrase_review`；非低档或未运行复核时不含这些字段。分数不是 AI 字数比例。安全代价与启用前限制见[评测记录](paraphrase-evaluation.md#商业许可候选与可选复核)。

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

其中 `e2e/a11y.spec.ts` 用 axe 检查输入页、单篇结果、中英分开结果和批量汇总表（WCAG 2 A/AA 加 best-practice 规则）。自动检查抓不全，颜色对比被渐变背景挡住时 axe 会标成“未确定”，这类地方要手算；读屏顺序和键盘操作也需要人工试一遍。

首次运行先执行 `npx playwright install chromium`。用 `E2E_PYTHON` 指定装好后端依赖的 Python，`PW_CHROMIUM_PATH` 指定已有的 Chromium。本地如果 8000 或 5173 端口已经有服务，测试会直接复用它们；在本机跑之前先 `停止.bat`，以免连到真实模型。

CPU 可选 ONNX INT8 路径：先安装 `backend/requirements-onnx.txt`，再运行 `experiments/export_onnx.py`。没有导出文件时后端继续使用 PyTorch。

## 上传限制

- 请求体最多 20 MB（按实际收到的字节数算，分块上传也一样），multipart 另留 1 MB 余量。
- `.docx` 是 zip，压缩后很小的文件可能解压得非常大。解压前会看 zip 目录：声明的解压总量超过 100 MB 或成员超过 5000 个就拒绝（`archive_too_large`）。
- PDF 最多 300 页（`too_many_pages`），在逐页抽文字之前检查。
- 这些数字在 `backend/app/extract.py`，错误文案里写了同样的数字（`backend/app/errors.py`），改的时候要一起改；测试会核对两者一致。
- 正文长度另有限制：中文约 10000 字、英文约 8000 词。

## 设计背景

第一版的设计说明保留在 [design/initial-spec.md](design/initial-spec.md)，其中写了模型选择、英文推理预算和错误文案的由来。它是历史文档，部分内容（例如“不做 PDF”）已经过时，文件顶部有说明。
