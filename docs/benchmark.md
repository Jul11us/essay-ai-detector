# 真实样本评测与阈值校准

评测调用网站实际的 `/api/detect` 文件上传流程，包含提取、正文预处理、分段、模型评分、全文聚合与充分度判断。阈值校准只改变全文的“较低 / 不确定 / 较高”判定边界，不修改模型，不把原始分数转换为作者概率。段落和逐句展示仍使用未校准的展示门槛。

## 样本与来源

本机样本、原始预测、报告和候选配置保存在被 Git 忽略的 `experiments/benchmark-private/`。不要把私人作文加入公开仓库。可运行 [公开 HC3 样本准备脚本](../scripts/prepare_benchmark.py)（参数与来源见 [公开语料说明](benchmark-dataset.md)），使用版本固定、能追溯原稿的中英人写/ChatGPT 问答。构造的混合稿记录拼接方法和组成样本，只单列分布。

HC3 问答不是学生作文；作者母语、教育背景通常未知，报告不能声称覆盖非英语母语作者。旧版 ChatGPT 数据不能代表所有新模型。校准/测试之间按问题组隔离，也不能证明它们未进入检测器训练集。只有经过证据核查排除训练重叠的样本，才可记录 `training_overlap=excluded`；未知应写 `unknown`，可能重叠写 `possible`。提供 `training_overlap_evidence` 说明证据，不能仅把字段改为 `excluded`。

每个样本在 `manifest.jsonl` 中占一行：

```json
{"id":"public-en-001-human","file":"samples/public-en-001-human.txt","lang":"en","label":"human","source":"有来源的数据集名称","source_url":"https://example.org/versioned-source","license":"已核查的来源许可","group_id":"original-question-001","split":"calibration","writer_group":"public_authors_unspecified","domain":"qa","training_overlap":"unknown"}
{"id":"public-en-001-ai","file":"samples/public-en-001-ai.txt","lang":"en","label":"ai","source":"同一来源记录的生成稿","source_url":"https://example.org/versioned-source","license":"已核查的来源许可","group_id":"original-question-001","split":"calibration","writer_group":"known_generation_model","domain":"qa","training_overlap":"unknown"}
```

标签只允许 `human`、`ai`、`mixed`；语言只允许 `en`、`zh`。`source` 必填，可补充 `dataset_revision`、`generated_model`、`mixed_method`、`components`。可填 `text_sha256` 核对输入文件的 SHA-256。输入文件必须在 manifest 目录之内，只接受 TXT/DOCX/PDF。

同原稿的 human/AI/mixed 版本共用 `group_id`，全部进入同一个 `split`；两个 split 只允许 `calibration` 和 `test`。脚本拒绝组泄漏、跨 split 的相同文件内容，以及用相同内容伪装成多个独立组。多个同组同类版本即使不泄漏，仍会产生统计相关，配置只标候选。旧 manifest 无 `split`、`group_id` 仍支持描述性评测，不能生成可用校准配置。

## 一次评分，可重放统计

先启动后端并确认所测中英模型均就绪。在 `backend/` 下运行；使用项目虚拟环境或已安装 `requirements-dev.txt` 的 Python：

```powershell
python benchmark.py ../experiments/benchmark-private/public-hc3/manifest.jsonl --api http://127.0.0.1:8000 --predictions-out ../experiments/benchmark-private/public-hc3/predictions.jsonl --out ../experiments/benchmark-private/public-hc3/report.json --calibration-out ../experiments/benchmark-private/public-hc3/calibration.json
```

后续直接重放预测，不再消耗模型推理时间：

```powershell
python benchmark.py ../experiments/benchmark-private/public-hc3/manifest.jsonl --predictions ../experiments/benchmark-private/public-hc3/predictions.jsonl --out ../experiments/benchmark-private/public-hc3/report.json --calibration-out ../experiments/benchmark-private/public-hc3/calibration.json
```

API 只允许 `http://127.0.0.1` 或 `http://localhost`，禁用代理环境变量和重定向。异常只报告样本 ID、HTTP 状态或固定错误说明，不回显服务器正文。报告和预测文件通过字段白名单保存 ID、来源、标签、原始分数、模型 ID/权重修订、处理后的字符/词数、充分度、API 时延；不写作文正文、段落摘录或本机绝对输入文件路径。

原始预测每行至少包含 `id`、`score`、`verdict`。旧预测缺少元数据仍可统计，无法验证校准。完整预测还需 `model_id`、`model_revision`、`confidence`（`low/medium/high`）、`char_count`、`word_count`、`latency_ms`、`api_pipeline="/api/detect"`。所有分数须是有限的 0–1 数值，布尔值、NaN、Infinity、重复 ID 和缺样本均拒绝。

## 报告读法

报告给出总体，以及按语言、处理后字符长度、作者来源组别、split 和交叉分组的计数。字符长度分为 `<400`、`400–1499`、`≥1500`，与充分度长度门槛对应。未知长度单列，不猜测原稿长度。

| 指标 | 分子 / 分母 | 意义 |
| --- | --- | --- |
| `human_high_false_flag` | 人写稿判较高 / 人写样本数 | 误报 |
| `ai_low_miss` | AI 稿判较低 / AI 样本数 | 漏报 |
| `human_uncertain`、`ai_uncertain` | 该类不确定 / 该类样本数 | 必须与误报、漏报一起阅读 |
| `confidence_insufficient` | 充分度为 low / 该分组总数 | 文本长度、段数等导致的判断不足 |
| `mixed_verdict_rates` | 混合稿某判定 / 混合样本数 | 仅结果分布，无二元准确率 |

率字段包含 `count`、`of`、`rate`、`wilson_ci`。分母为 0 时后两者为 `null`；零次误报也有大于零的置信上界，不能解释成误报概率为零。报告同时列出组数。Wilson 区间反映这些样本上的比例不确定度，不保证真实人群表现；相关版本、选择偏差、训练重叠均可能造成乐观估计。

时延是客户端一次完整请求的耗时，包含上传、提取、预处理和推理，排除服务器启动；报告给出均值、中位数和 P95。重放报告保留原请求的时延。不同设备、文本长度、冷启动情况不能混作性能承诺。

## 校准与独立验证

默认策略是每个语言、每个 split 至少 30 个独立组的人写稿和 30 个独立组的 AI 稿，95% Wilson 区间；误报、漏报的上界均不得超过 20%。可用 `--min-samples-per-class`、`--confidence-level`、`--max-false-positive-rate`、`--max-false-negative-rate` 显式配置，策略随结果保存，不能隐藏为得出好看的数字而放宽过的约束。

仅使用校准集的人写和 AI 分数拟合低/高阈值，在约束内尽量减少不确定结果。混合稿不参与拟合。阈值锁定后再看独立测试集；测试分数不进入候选网格、目标或阈值选择。同一语言混用模型 ID 或修订直接报错。判定与 API 一致：`score < low` 为较低，`score >= high` 且充分度不为 `low` 才能较高，其余不确定。

| 配置状态 | 含义 | 网站行为 |
| --- | --- | --- |
| `validated` | 类别/独立组数量、可追溯元数据、训练重叠证据、校准和独立测试误报/漏报 CI 均满足策略 | 用户显式配置后，可用于适用范围内的全文判定 |
| `candidate` | 有拟合阈值，但样本不足、测试失败、训练重叠未排除或元数据不全 | 保留研究结果，继续默认门槛 |
| `unvalidated` | 缺少类别，或找不到满足校准约束的阈值 | 继续默认门槛 |

`validated` 只表示记录来源范围内通过本次策略，不是通用作文准确率。不能依据这一状态宣称句子、段落、未知母语作者或新模型已验证。很低的误报和漏报可能同时伴随大量不确定，报告不会把不确定算作检测成功。

配置核心格式如下；真实文件还含适用来源、分组计数、区间和拒绝原因：

```json
{
  "schema_version": 1,
  "profile_version": "thresholds-v1",
  "dataset_fingerprint": "manifest-metadata-sha256",
  "evaluation_unit": "document",
  "score_semantics": "raw_model_score_not_authorship_probability",
  "policy": {"max_false_positive_rate":0.2,"max_false_negative_rate":0.2,"confidence_level":0.95,"min_samples_per_class":30},
  "languages": {
    "en": {
      "model_id":"actual-model-id",
      "model_revision":"actual-weight-fingerprint",
      "status":"candidate",
      "low":0.4,
      "high":0.75,
      "reasons":["example only; requires independent validation"],
      "training_overlap":{"status":"unknown","evidence":[]},
      "counts":{"calibration":{"human":30,"ai":30,"mixed":0,"groups":30,"groups_by_label":{"human":30,"ai":30,"mixed":0}},"test":{"human":30,"ai":30,"mixed":0,"groups":30,"groups_by_label":{"human":30,"ai":30,"mixed":0}}},
      "applicability":{"char_count":{"min":400,"max":2500},"evaluation_unit":"document"}
    }
  }
}
```

配置中的 `training_overlap` 汇总原始记录的状态和证据。只要任一样本未通过排除核查，就保持 `unknown` 或 `possible`，不能启用。适用字符范围和作者组别由人写/AI 二元样本确定，混合稿的长度和构造组别不能扩展有效范围。

网站不自动寻找或启用候选文件。通过 `DETECTOR_CALIBRATION_PATH` 指定本机配置文件后启动后端，运行时仍核对语言、模型/修订、状态、训练重叠证据、样本计数、策略、独立验证指标和字符范围。失败时沿用默认门槛，并在检测结果中说明。配置只适用于全文；用户局部修改后重新聚合，若长度超出适用范围，也会恢复默认门槛。

```powershell
$env:DETECTOR_CALIBRATION_PATH = (Resolve-Path ../experiments/benchmark-private/public-hc3/calibration.json).Path
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

没有合格的真实验证结果时，完成评测和生成候选配置仍有价值，但不应宣称已经提高准确率或已取得生产可用阈值。实际本机结果保存在语料目录的 `summary.md`，与原始预测、完整报告和配置一起复核。
