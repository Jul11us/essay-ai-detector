# 大学生作文 AI 率查询站 — 第一版设计

日期：2026-09-13  
状态：已确认；2026-09-13 英文引擎改为本地 Vanguard

## 1. 目标与非目标

给国内大学生做一个**本机优先**的中文网站：粘贴或上传英文/中文 essay，用手选语言调用开源检测模型，给出**可解释、偏保守**的 AI 倾向，而不是一个吓人的黑盒百分比。

**做：**

- 中文界面
- 粘贴正文，或上传 `.txt` / `.docx`
- 用户必须选择「中文」或「英文」
- 按段落打分，全文分为各段按字数加权
- 总分 + 置信度 + 人话解释 + 各段倾向
- 本机推理；英文用已落地的 Vanguard 权重，中文模型下载失败时只换镜像源；不把作文发给第三方打分

**不做：**

- 改写、降 AI 率
- PDF
- 自动识别语言并换模型
- 账号、云端历史、本机历史
- 对打知网 / Turnitin / GPTZero
- 第一版公网部署（目录按以后能拆开上线来写）

## 2. 用户与使用场景

- 用户：大学生，查自己的课程作业或学期论文（约到 8000–10000 字量级）
- 场景：打开本机网站 → 选语言 → 粘贴或上传 → 看总分和哪几段更像 AI
- 成功标准：语言选错、过短、解析失败时**不出分**；正常稿能在本机 CPU 上跑完并看到段落列表；页面写明这不是学校官方检测

## 3. 系统结构

```
降ai率网站/
  backend/          # FastAPI，唯一会加载 PyTorch 模型的进程
  frontend/         # Vite + React，中文单页
  docs/             # 设计与计划
  README.md         # 安装、启动、第一次下模型
```

本机开发跑两个进程：后端 `127.0.0.1:8000`，前端 `127.0.0.1:5173`，前端把 `/api` 代理到后端。以后上线时前端打成静态文件，后端单独部署；第一版不写云配置。

职责边界：

| 单元 | 做什么 | 不做什么 |
|------|--------|----------|
| `extract_text` | txt/docx → 纯文本 | 不打分 |
| `check_length` | 过短/过长 | 不看语言 |
| `check_language` | 所选语言与正文是否明显冲突 | 不自动改语言 |
| `split_paragraphs` | 切段、过长段切窗 | 不调用模型 |
| `score_windows` | 模型前向，得到 P(AI) | 不决定文案 |
| `aggregate` | 加权总分、置信度、结论档 | 不访问磁盘 |
| `explain` | 固定模板生成中文解释 | 不二次推理 |
| HTTP API | 校验入参、映射错误码 | 不含 UI |
| 前端 | 必选语言、上传、展示、复制 | 不在浏览器里跑模型 |

## 4. 模型与下载

### 英文（第一版主路径）

- 模型：本地已部署的 **Vanguard**（Hugging Face id `ShantanuT01/vanguard-ai-text-detector`，MIT，ModernBERT-large）
- 权重目录：默认 `experiments/models/vanguard`；可用环境变量 `VANGUARD_MODEL_PATH` 覆盖
- 加载：`local_files_only=True`，`attn_implementation="eager"`，`reference_compile=False`；核对 `missing_keys` / `unexpected_keys`
- 输出：分类头 **单个 logit**，`P(AI) = sigmoid(logit)`。禁止按二分类 softmax 或 `label=1` 解读。`id2label` 只有 `LABEL_0`，不要走人类/AI 标签解析
- 上下文：`max_position_embeddings = 8192`。但分段器把英文单元限制在 1200 字符（≈300 token），**这条流水线到不了 8192**。实际推理预算固定为 `scoring.EN_INFER_TOKENS = 2048`（最坏情况 1 字符 = 1 token，仍有充足余量），保证英文单元恒为「一段一窗」。禁止再按 `max_position_embeddings` 配置窗口假装用满长上下文；要真吃满，必须同时调大分段上限。超出预算的单元仍走滑窗兜底（`stride = EN_INFER_TOKENS / 2`）
- 批量：窗口按宽度反推 batch（`scoring.batch_size_for`），长窗退化为单条。eager attention 的分数矩阵按 `seq²` 增长，固定 `batch=8` 配长窗会一次吃掉几十 GB
- 运行时不下载英文权重；目录缺失则英文 `models.en=false`，选英文检测返回 `models_not_ready`


### 中文

- 模型：`yuchuantian/AIGC_detector_zhv3`（Apache-2.0）
- 二分类 softmax。官方口径 0=人类、1=AI。仓库 `config.json` 没有 `id2label`，加载后会变成 `LABEL_0` / `LABEL_1`；解析时忽略这种占位名（`label` 里含有 `ai` 不能当成 AI 类）。若只有两个未标注类，用 index `1`。禁止把 Vanguard 的单 logit 当 softmax。
- **方向自检（必须）**：这个仓库的模型卡除了 license 是空的，「0=人类」没有任何文档支撑，方向猜错不会报错、只会把分数变成 `100 - 正确值`。所以中文加载完必须用一对固定样本（`app/sanity.py`）验方向：明显 LLM 腔的中文应显著高于人写的现代白话文。只有反过来超过 `INVERSION_MARGIN` 才判方向反了并让中文不可用（fail closed）；信号弱但不颠倒要放行。实测参考值：AI 腔 0.9994、朱自清《背影》0.4591。自检结果写进 `/api/status` 的 `label_check`
- 滑窗：`max_length=512`，`stride=256`（中文 800 字上限超过 512 预算，所以中文每段通常切 2 个以上窗口，与英文刻意相反）
- 下载顺序（只下权重，正文永不上传）：本地缓存 `local_files_only` → Hugging Face Hub → `https://hf-mirror.com` → ModelScope `snapshot_download`。每一环失败要记进尝试列表，最终失败时把「试过哪些源」和「是不是没装 modelscope」写进错误信息，不能只留一个裸异常。仍失败则中文不可用，**禁止**云端打分


### 就绪策略

- `GET /api/status` 的 `models.zh` / `models.en` **分别**报告
- `phase=ready` 表示至少一种语言可测；`phase=error` 表示一种都没有
- `phase`/`detail` 按「已加载的语言 + 显式记录的失败原因」推导，禁止用「detail 里有没有『失败』两个字」这类字符串嗅探
- 除 `phase` / `detail` / `models` 外，额外返回 `heads`（每种语言实际用的头、softmax 头的 AI 类下标）和 `label_check`（中文方向自检实测值），便于不读源码就能排查
- `POST /api/detect`：**先校验 `lang`，再问模型是否就绪**，否则 `lang=fr` 且模型未加载时会错误地返回 503；只要求**当前所选语言**已加载，否则 503 `models_not_ready`。英文已就绪时，不必等中文下完
- `transformers` + `torch` CPU（有 CUDA 则用 GPU，不是硬性要求）
- 推理必须串行：一次只跑一个 `/api/detect`（`main.infer_gate`，用 `threading.Semaphore` 在 worker 线程里取，避免 `asyncio.Lock` 被单个事件循环绑死）


## 5. 检测流水线

顺序固定，任一步失败则停止，响应里**没有** `score` 字段。

### 5.1 入参

- `lang`：必须是 `zh` 或 `en`
- 正文来源二选一：JSON 的 `text`，或 multipart 文件字段 `file`
- 同时给文本和文件时：以文件为准，忽略 JSON 文本
- 文件扩展名只允许 `.txt`、`.docx`（大小写不敏感）；其他一律 `parse_failed`
- 请求体上限 `MAX_UPLOAD_BYTES = 20 MB`：先按 `Content-Length` 提前拒绝，读取阶段再按 1 MB 分块累计复核（禁止 `await upload.read()` 把任意大的文件整个读进内存）；超限 → `payload_too_large`
- JSON 解析失败或顶层不是对象 → `bad_request`（不要复用手 `empty`，那会谎报成「没有读到正文」）


### 5.2 抽文本

- `.txt`：先 UTF-8，失败再 GBK/GB18030；仍失败 → `parse_failed`
- `.docx`：`python-docx` 读取非空段落，用两个换行拼成一篇；损坏文件 → `parse_failed`
- 抽完后去掉首尾空白；空 → `empty`

### 5.3 长度

计数：去掉所有 Unicode 空白后的字符数 `n_chars`。英文另计空白切分词数 `n_words`。

| 语言 | 过短 | 过长 |
|------|------|------|
| `zh` | `n_chars < 150` → `too_short` | `n_chars > 10000` → `too_long` |
| `en` | `n_chars < 200` → `too_short` | `n_words > 8000` → `too_long` |

过长不截断、不打分，提示自行拆篇。

### 5.4 语言是否明显不符

只拦「点错按钮」，不拦少量夹杂。

- `cjk`：Unicode 汉字（CJK Unified Ideographs 及扩展）个数
- `latin`：拉丁字母个数
- `ratio_cjk = cjk / (cjk + latin)`；分母为 0 则视为无法判断，**不拦**（随后由过短等规则处理）

拒绝条件：

- 用户选 `en`，且 `cjk >= 80` 且 `ratio_cjk > 0.50` → `language_mismatch`
- 用户选 `zh`，且 `latin >= 80` 且 `ratio_cjk < 0.15` → `language_mismatch`

英文作业里的中文姓名、中文论文里的英文引用：达不到上面阈值则放行。

### 5.5 切段

1. 若来自 docx 且已有自然段落，用这些非空段
2. 否则按两个及以上换行切开
3. 若只有一段且该段超过 800 字（zh）或 1200 字符（en），再按单换行切
4. 仍过长的单段：按句号 / `.` / `!` / `?` / `。` `！` `？` 切开，再按语言上限打包（中文约 800 字，英文约 1200 字符）。真正的 token 滑窗在打分阶段按语言推理预算做
5. 去掉 trim 后长度 &lt; 20 的段；它们不参与加权。若没有任何可打分段 → `too_short`

上限与下限必须是具名常量（`paragraphs.SEGMENT_CHARS` / `paragraphs.MIN_SEGMENT_CHARS`），并写清它们和推理预算的关系：中文 800 字超过 512 预算，所以每段通常切 2 个以上窗口；英文 1200 字符远低于 2048 预算，所以恒为一段一窗。改任何一边都要同步另一边的测试。

20 字符下限的理由：标题、残句只有几个 token，单段方差极大。实测一篇人类作文的 6 词标题可得 16.7%，而同文正文段落接近 0%。它们权重虽小，但会污染段落列表的观感。

### 5.6 打分

对每个可打分段：

- **英文 Vanguard**：正文 token 不超过 `EN_INFER_TOKENS = 2048` 则一次前向，`P(AI)=sigmoid(logit)`（logit 必须是标量）。超过则 `max_length=2048`、`stride=1024` 滑窗
- **中文 zhv3**：滑窗 `max_length=512`、`stride=256`，softmax 取 AI 类概率
- 滑窗切的是**不含特殊符号的正文 token**；每一窗再用 `build_inputs_with_special_tokens` 补上 `[CLS]` / `[SEP]`（或该模型等价标记），禁止把已编码序列生切导致后窗丢失句首标记
- 段分 = 各窗口按 token 数加权平均
- **全文分仍是各段按字数加权**，不另对整篇再打一次当作总分

全文分：

```
score = sum(p_i * w_i) / sum(w_i)
```

`w_i` 为该段去空白后的字符数。结果保留四位小数，前端百分比显示一位小数。

### 5.7 置信度与结论档（偏保守）

段落分的标准差为 `std`（不足两段则 `std = 0`）。

**置信度 `confidence`：**

- `low`：`n_chars < 400`（en 同样用字符数）或可打分段数 &lt; 2
- `high`：`n_chars >= 1500` 且 `std < 0.15`
- 其余：`medium`

**差异提示 `mixed_variance`：** `std >= 0.25` 为 true。为 true 时结果页必须写「各段差异大，不宜只看一个总分」。

**结论 `verdict`：**

| 值 | 条件 | 中文展示 |
|----|------|----------|
| `low` | `score < 0.40` | 较低 |
| `high` | `score >= 0.75` **且** `confidence != low` | 较高 |
| `uncertain` | 其他（含高分但置信度为低） | 不确定 |

禁止在 `too_short` / `language_mismatch` 等错误响应里附带分数。

### 5.8 解释文案

由模板拼接，不另调大模型。接口额外返回 `basis`（判定依据）、`reading`（这个数字表示什么），以及作业审查估计：`review_risk`、`review_label`、`review`。`explanation` 为依据、阅读说明、审查估计加上差异/短文提示的合稿，供复制。

`review_risk`：

| 值 | 条件 | 页面口径 |
|----|------|----------|
| `likely_ok` | 置信度不是低，总分较低，且没有高分段、没有各段大分歧 | 按本站分数，文风上较不易被判高 |
| `likely_flag` | 全文较高，或至少两段较高 | 较可能被盯成 AI 文风 |
| `unclear` | 其余（短文、中间档、一段偏高、各段差大） | 不好说 / 材料偏短没法估 |

文案必须写明：这是本站开源模型的估计，不是学校官方审查，保证不了 Turnitin / 知网 / GPTZero。

必须包含：

1. 用了哪套开源模型（中文或英文的 Hugging Face id）
2. 比较的是写作分布，不是生成记录、事实对错或知网 / Turnitin
3. 总分由各段加权；档位 40% / 75%，中间档放宽
4. 若分数 `< 0.1%`：写明接近 0% 不是「证明是人写的」
5. 若 `mixed_variance`：点明分段看
6. 若 `confidence == low`：点明文本偏短或段少，参考价值有限
7. 正式学术写作可能推高分数（写在依据或阅读说明里）
8. 结果区展示作业审查估计，且不得写成「一定能过学校系统」

## 6. HTTP API

前缀 `/api`。JSON，UTF-8。

### `GET /api/status`

```json
{
  "phase": "downloading",
  "detail": "正在下载中文模型…",
  "models": { "zh": false, "en": false },
  "heads": {
    "zh": { "kind": null, "ai_index": null },
    "en": { "kind": null, "ai_index": null }
  },
  "label_check": {}
}
```

`phase`：`downloading` | `ready` | `error`  
`ready` = 至少一种语言可测。`detail` 说明当前在加载哪一种。英文已就绪时，选英文可以检测，不必等中文。  
`heads.zh.ai_index` 中文就绪后为 `1`，`heads.en` 为 `{"kind":"sigmoid","ai_index":null}`。  
`label_check.zh` 中文就绪后为 `{"ai_style": …, "human_style": …}`；方向反了中文直接不可用，不会出现在这里。


### `GET /api/health`

进程活着即 200。不代表模型已就绪。

### `POST /api/detect`

成功 200：

```json
{
  "score": 0.6234,
  "verdict": "uncertain",
  "confidence": "medium",
  "mixed_variance": false,
  "char_count": 1820,
  "word_count": 312,
  "model_id": "ShantanuT01/vanguard-ai-text-detector",
  "lang": "en",
  "explanation": "……",
  "basis": "……",
  "reading": "……",
  "review_risk": "unclear",
  "review_label": "作业审查：不好说，有可能被问到",
  "review": "……",
  "disclaimer": "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。",
  "paragraphs": [
    {
      "index": 0,
      "excerpt": "前 80 字…",
      "score": 0.31,
      "verdict": "low",
      "char_count": 268
    }
  ]
}
```

`char_count` 是去空白后的字符数，也就是该段在全文里的权重。前端靠它判断一段是不是短到「单独打分不稳定」并折叠起来，所以必须返回，不能只给 `excerpt`（`excerpt` 被截到 80 字符，从它反推段长是不可靠的隐式约定）。

段级 `verdict` 只用 0.40 / 0.75 两个切分，**不**因全文 confidence 把段级 high 压成 uncertain（段级没有 low-confidence 降档）。段级 excerpt 不超过 80 个字符，多出加省略号。

失败：

| HTTP | `error` | 何时 |
|------|---------|------|
| 400 | `lang_required` | 缺少或不是 zh/en（**先于**任何模型就绪检查） |
| 400 | `bad_request` | 请求体不是合法 JSON，或顶层不是对象 |
| 400 | `payload_too_large` | 请求体超过 20 MB |
| 400 | `empty` | 抽完为空 |
| 400 | `too_short` | 过短或没有可打分段 |
| 400 | `too_long` | 过长 |
| 400 | `language_mismatch` | 语言明显不符 |
| 400 | `parse_failed` | 文件类型不对或损坏 |
| 503 | `models_not_ready` | 仍在下载或加载 |
| 500 | `infer_failed` | 推理异常 |

失败体只有 `error` 与中文 `message`，没有 `score`。

## 7. 界面

单页，中文。不设路由。

1. 标题：作文 AI 率查询
2. 免责声明（常驻，检测前也可见）
3. 语言：两个按钮「中文」「英文」，未选时「开始检测」不可用
4. 多行输入框（粘贴）。上传区只接受 `.txt` / `.docx`：选中文件后显示文件名，可清除。提交时若有文件，只把文件和语言发给后端（忽略文本框）；若无文件，把文本框和语言以 JSON 发给后端。未选文件且文本框为空 → 前端提示「请粘贴或上传」，不发请求。
5. 开始检测
6. `status !== ready` 时按钮不可用，显示 `detail`
6.1 **检测进度与取消（必须）**：`busy` 期间在按钮下方显示已用时间（每秒走一次，`formatElapsed`）和「取消检测」，用 `AbortController` 中断请求；取消后按钮恢复可用。十分钟兜底超时（`DETECT_TIMEOUT_MS`），文案要和用户主动取消区分开。`busy` 期间锁定语言按钮、文本框、文件输入，避免结果对应不上刚改的正文。禁止出现「按钮永远显示正在检测、没有任何出路」的状态

**取消的确切语义（别写成"停止推理"）**：`AbortController` 只让**浏览器停止等待**。后端那次推理跑在 `asyncio.to_thread` 的工作线程里，Python 杀不掉已启动的线程，所以它会跑完，CPU 不会立刻释放。取消的收益是：页面立刻可用、不再排队等一个已经不想要的结果、后续窗口不会再多占资源。

要真正早停，得在 `run_detect` 的段落循环里查一个 `threading.Event`（每段之间可中断，当前那一段仍会跑完）——中文万字稿有十几个段落，这样能省掉大部分 CPU。本轮**没做**，是有意的取舍。
6.2 **状态轮询要在加载结束后停（必须）**：`/api/status` 只在 `loading === true` 时按 2 秒轮询；`loading` 变 false 后 `models` 就是最终结果（就绪或失败），停止轮询。禁止用固定 `setInterval` 无限轮询。连不上后端时保持重试（通常只是服务还没起来）。判定依据必须是后端显式给出的 `loading`，不能靠嗅 `detail` 文案——`phase` 在英文就绪后就变 `ready`，光看 `models` 分不清中文是「还在下」还是「失败了」
7. 结果区：总分百分比（一位小数）、结论档、置信度、解释、`mixed_variance` 提示、段落列表（摘录 + 该段较低/不确定/较高）、复制全部结果为纯文本
7.1 **过短的段要折叠（必须）**：`char_count < SHORT_PARAGRAPH_CHARS`（80）的段默认收进 `<details>`，摘要写明「另有 N 个过短的段（不足 80 字，单独打分不稳定，仅供参考）」。实测一篇人类作文里 32 / 27 字符的小标题得分 16.7% / 5.8%，而正文段落是 0%——权重虽小，并排显示会让人误以为「这一段有问题」。若整篇都是短段（如只有几个小标题），不折叠、照常列出。折叠是**纯展示**，不改分段、不改权重、不改任何分数；复制文本里给这些段加「（过短，仅供参考）」标注
8. 关闭或刷新即清空（不写 localStorage）

复制文本至少包括：语言、模型 id、总分、结论、置信度、解释、各段摘录与分数。

视觉：干净、可读、不像「作弊工具」。结论「较高」用沉稳强调色，不使用恐吓文案。

## 8. 错误文案（固定）

- `lang_required`：请先选择中文或英文。
- `bad_request`：请求格式不对。请刷新页面后重试。
- `payload_too_large`：提交的内容太大（上限 20 MB）。请只提交正文文本。
- `empty`：没有读到正文。
- `too_short`：文本太短，无法给出可靠结果（中文至少约 150 字，英文至少约 200 个字符）。
- `too_long`：文本超出第一版上限（中文约 10000 字，英文约 8000 词），请拆成多篇再测。
- `language_mismatch`：正文语言和所选语言明显不符。请改选后重试；本站不会在选错时给出分数。
- `parse_failed`：无法读取文件。请使用 UTF-8 或 GBK 的 .txt，或未损坏的 .docx。
- `models_not_ready`：模型还在准备，请稍后再试。
- `infer_failed`：本机推理失败，未生成分数。

## 9. 运行与环境

- Python 3.11+，Node.js 20+
- 后端：`fastapi`、`uvicorn`、`transformers`、`torch`、`python-docx`、`huggingface_hub`；ModelScope 作为下载兜底依赖
- 前端：Vite + React + TypeScript
- README 写清：首次下载体积、CPU 会较慢、文本默认不出机
- 不提交模型权重、不提交 `.env` 密钥（本版无云端推理密钥）

## 10. 测试（实现时必须覆盖）

不依赖真实 GPU。模型前向用假模型或 mock；规则测试用真实函数。

**黄金分数检查（`backend/golden.py` + `tests/golden_baseline.json`）**：上面这些测试全部用 mock 模型，所以靠升级依赖（`requirements.txt` 里 `torch` / `transformers` 都没固定版本）或改动分段、加权、档位逻辑导致的分数漂移，它们一个都不会红。因此额外用**真实模型**跑固定样本（英文 `experiments/essay.txt`、一段触发中文滑窗的中文样本、中文方向自检的两个样本），把总分、档位、置信度、逐段分数/档位/字符数记进基线，之后比对。

- 收录范围必须包含**逐段档位和逐段字符数**，否则改 `paragraph_verdict` 阈值或分段逻辑不会红
- 容差 `GOLDEN_TOLERANCE = 1e-4`：同机实测线程数 1→32 时未取整概率最大漂移约 5e-7，取整后分数完全一致；1e-4 留约 200 倍余量，又远小于一次显示跳动（1e-3）。跨机器 / BLAS 差异未实测，若换机器后满屏极小 delta，就该放宽这个数
- 默认不跑（`pytest.ini` 里 `addopts = -m "not golden"`），因为要加载 1.5 GB 权重；跑法 `pytest -m golden`
- 权重或基线缺失时 `pytest.skip`，不能变成"没跑就等于通过"
- 有意改动分数时用 `python golden.py` 重新录制，并把基线 JSON 的 diff 一起提交，让"分数变了多少"成为一次可见的评审
- 回归检查本身必须有牙齿：把 `MIN_SEGMENT_CHARS` 改成 40 这类改动应当让 golden 变红（已实测，会报出 `en_essay.score: 0.007 -> 0.0029（差 4.10e-03）` 与「长度 7 -> 5（分段变了？）」）

其余必须覆盖：

- 过短 / 过长 / 空 / 坏文件 / 错误扩展名 → 对应 error，无 score
- `lang=fr` 且模型未加载 → `lang_required`（400），不是 `models_not_ready`
- 畸形 JSON / 顶层非对象 → `bad_request`；声明或实际超过 20 MB → `payload_too_large`
- 权重加载 `missing`/`unexpected`/`mismatched` 任一非空 → 抛错（中英文走同一套校验）
- 中文方向自检：颠倒 → 拒绝；弱信号但不颠倒 → 放行
- 英文分段上限 < `EN_INFER_TOKENS`，保证一段一窗；中文必须真的走滑窗
- 并发闸门：4 个线程同时提交，实际并发峰值为 1
- 选 en 的长中文、选 zh 的长英文 → `language_mismatch`
- 英文正文夹少量汉字 → 不误拦
- 两段不同长度 → 全文分等于字数加权，允许浮点误差 1e-6
- `score=0.80` 且 `confidence=low` → `verdict=uncertain`
- `score=0.80` 且 `confidence=medium` → `verdict=high`
- 前端：未选语言、且无文件又无正文时，不能发出检测请求（用组件测试锁住：按钮 `disabled` 且 `fireEvent.click` 后 `/api/detect` 调用数为 0）
- 前端：检测中出现已用时间和取消按钮，取消后回到可用状态并给出「已取消检测。」；`busy` 期间语言按钮与文本框被锁定
- 前端：段列表把 `char_count < 80` 的段折进 `<details>`；整篇都是短段时不折叠；复制文本带「（过短，仅供参考）」标注
- 前端：`loading` 为 true 时按 2 秒轮询 `/api/status`，变 false 后必须停止（用假计时器断言：推进 60 秒后请求数不再增长）；连不上后端时保持重试
- 前端测试必须在 `setupTests.ts` 里显式 `cleanup()`：vitest 没开 `globals`，RTL 的自动清理不会注册，否则多个 `<App />` 会留在 DOM 里导致查询撞车

## 11. 刻意不动的两个数

这两项**有数据之前不要改**，改了就重新录制 `tests/golden_baseline.json`：

- **档位 40% / 75%**（§5.7）。宽中间档是刻意的：宁可漏判，也不把工整中文直接判成 AI。一篇《背影》落在「不确定」不能证明 40% 定错了——它是 1920 年代文学腔，对模型属于域外样本。要校准得拿若干篇真作业的人写稿与明确 AI 稿对照。
- **英文分段上限 1200 字符**（§5.5）。作业里正常一段几十到一百来个词，早就低于这个数，根本不会被切开；只有整篇没有空行、糊成一堵墙时它才动手。改成 5000 不会改善正常段落，只影响那种超长整段。提高它会改变分数，在拿到对照集之前不值得冒这个险。

## 12. 风险

- 学术正式文体假阳性：用宽「不确定」带和免责声明缓解，不承诺准
- CPU 上万字会慢：分段推理，前端显示进行中；不因此截断
- 国内下载模型失败：镜像链用尽则 `error` 态，不改云端打分
- 开源检测可被改写绕过：第一版不提供改写，文档不宣传「过学校检测」
- 取消检测不会立刻释放 CPU（§7 6.1）：只停止浏览器等待，后端那次推理会跑完

