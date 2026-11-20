# 独立论文候选评测集与自愿投稿

此流程采集**有逐篇许可、作者署名、日期证据的论文候选集**，不是经过作者核验的“纯人工写作”真值集。正文、原始响应和任何私人材料只保存在 git 忽略的 `experiments/benchmark-private/independent/`；不要强制提交或公开缓存。采集与选择不读取检测分数。

## 准入与时间边界

`scripts/prepare_independent_benchmark.py` 中的 `CUTOFFS` 是时间边界及 HF 提交证据的唯一实现来源：

| 语言 | 固定模型与 revision | 严格晚于（UTC） | 提交证据 |
| --- | --- | --- | --- |
| en | `ShantanuT01/vanguard-ai-text-detector` / `823061be63b90f2b42f64ac1e1f82772e872533b` | `2026-07-18T18:49:59Z` | [HF commits API](https://huggingface.co/api/models/ShantanuT01/vanguard-ai-text-detector/commits/823061be63b90f2b42f64ac1e1f82772e872533b) |
| zh | `yuchuantian/AIGC_detector_zhv3` / `47695ff451b32c225dd938f4f478f7fdc6aa6bb0` | `2025-06-24T23:49:44Z` | [HF commits API](https://huggingface.co/api/models/yuchuantian/AIGC_detector_zhv3/commits/47695ff451b32c225dd938f4f478f7fdc6aa6bb0) |

模型卡没有明确训练截止日期。上述固定提交日期是保守筛选界限，不是已证实的训练截止：英文提交还是 README 更新，不能据此推断首次权重发布时间。晚于固定权重快照才出现的文本不可能用于该快照训练，但晚发表不等于晚创作；旧草稿、复用段落和更早版本仍可能存在。`training_overlap=excluded` 在此仅表示通过**附带假设的时间筛选**，证据字符串会保留这一限制，不能解释为完成了训练语料审计。

- 英文：export API 按 `submittedDate` 搜索；OAI `arXiv` 确认逐篇许可和署名，`arXivRaw` 确认 **v1** 日期，而非元数据修改时间。只获取对应 `arxiv.org/html/<id>v1`，核对 HTML 许可；没有 HTML、许可不一致或无 v1 记录则拒绝。预印本 `published_at` 使用 v1 公开日期，不代表期刊出版日期。
- 中文：`scripts/independent-seeds.jsonl` 是约 40 个搜索发现的 Hans/JTO 候选 URL（无正文）。候选的年份/搜索摘要不是准入证据。每篇从抓取的 PDF/文章 HTML 本身核对署名、CC 许可、收稿日期、出版/发布日期。收稿日期是保守的早期稿件代理，**不是已核实的首次公开日期**；更早草稿不可排除。Hans 正文与许可从 PDF 提取；JTO 从文章元数据页及其链接的 RichHTML 提取，正文不可访问时拒绝，不用摘要替代全文。
- 只接受 CC BY、CC BY-SA、CC0；NC/ND、无明确逐篇许可、无作者、日期缺失/早于或等于界限、日期倒置、未来发表、全文过短/语言不符、声明 AI 使用均拒绝。
- 检查简单的英中文 AI 使用/未使用声明，记录 `none_found|declared_no_ai|declared_ai_use`；没有声明**不等于**没有使用。启发式也可能漏检、误检，正式评测前需要人工审阅原始证据。
- 对 NFKC、空白归一化后的全文去重。中文每刊最多 `ceil(--limit-zh / 2)` 篇（至少 1）；Hans 按 PDF 内期刊标识区分。短缺时不降低规则、不伪造样本，也不保证填满配额。

HTML 提取会移除导航、作者块、参考文献、公式和表格等；PDF 以提取的正文为主，复杂排版可能残留页眉/表格或丢失字符。应人工检查文本质量。`label=human` 是来源标签，`authorship_evidence=publication_claim` 表示出版方的作者声明；同行评审、署名、许可均不能证明未受 AI 帮助。这些候选不应独立作为高风险场景的人类真值。

## 运行与复现

从仓库根目录使用已配置的 Python 环境（包含 `pypdf`）：

```bash
.venv-detector/bin/python scripts/prepare_independent_benchmark.py --limit-en 2 --limit-zh 2
.venv-detector/bin/python scripts/prepare_independent_benchmark.py --limit-en 2 --limit-zh 2 --offline
# 更严格的最早日期（不能放宽模型界限）；自定义输出必须仍在 private 根目录内
.venv-detector/bin/python scripts/prepare_independent_benchmark.py --since 2026-09-01 --limit-en 10 --limit-zh 20
```

产物：`manifest.jsonl`、UTF-8 `samples/*.txt`、`preparation.json`（包括筛选规则、配额、逐候选 accepted/rejected/skipped 及原因、manifest SHA-256）、`raw/*.bin` 和响应元数据（URL、状态、内容哈希、抓取时间、Retry-After）、`raw/rate-state.json`。原始缓存包含署名和全文，不能当作可公开报告。Manifest 只带规范化作者字符串的 SHA-256，不带姓名；姓名哈希仍可能可链接，不等于匿名化。`dataset_revision` 标识参与提取的响应内容哈希。

固定相同脚本版本、缓存、seed 文件、配额与 `--since` 重建；离线模式绝不联网，缓存缺失或校验失败会明确拒绝。发现 API 每次查询至多取 `limit-en * 4`（上限 200）条；不保证全量检索。需保存完整输出目录与运行参数，后续网络内容变化不会覆盖已有响应；更新数据请另用新的私有 `--out` 目录。不要并行运行多个采集进程。

请求串行，使用带项目联系 URL 的 User-Agent。arXiv 网站请求间隔至少 15 秒，export/OAI API 共享至少 3 秒间隔，Hans 至少 60 秒，JTO 默认至少 3 秒；遵守更长的 robots crawl-delay。只访问允许的主机和 versioned HTML，从不请求 `/src` 或 `/e-print`。站点 robots 无法确认则拒绝；API 使用其文档许可。429/503 及 Retry-After 会缓存、持久化冷却，不立即重试；重定向不自动跟随。HTTP 错误缓存也会在离线重建中保持拒绝，需新目录开始新的采集快照。

本地启动真实后端 API 后评分（不要用测试 stub）：

```bash
cd backend
D=../experiments/benchmark-private/independent
../.venv-detector/bin/python benchmark.py "$D/manifest.jsonl" --api http://127.0.0.1:8000 \
  --predictions-out "$D/predictions.jsonl" --out "$D/report.json"
```

Manifest 沿用现有字段，并新增 `author_names_sha256`、`first_version_at`、`published_at`、`authorship_evidence`、`ai_use_declaration`、`consent_reference`。日期可为 ISO 日期或带时区时间戳；作者哈希为 64 位小写十六进制；枚举及投稿授权引用在 benchmark 和评测导入 API 校验。网页记录 `consent_reference=null`，许可不是个人参与研究的知情同意。导出报告保留安全引用、不含正文或输入文件路径；引用本身仍不得包含姓名/联系方式/授权书 URL 等隐私信息。

## 教师/学生自愿投稿（本步骤仅预留字段，不提供上传服务）

作文应通过自愿投稿而不是从网页搜索冒充学生作品。私有证据登记应保存：

1. 稳定 sample ID、作者内部 ID/受限身份核验、作者姓名规范化规则与哈希；教师仅可提交其有权授权的作品。教师不能代替学生确认作者身份或 AI 使用情况。
2. 原始文件哈希、创作开始/完成日期、首次版本日期、版本历史/草稿及其核验记录，是否曾公开/重用、对应来源 URL；不得用上传日期代替创作时间。
3. 作者对人工写作与 AI 使用范围的具体声明（生成、改写、翻译、润色分别说明），收集者审核记录；准确填写 AI 声明枚举，不能默认 `declared_no_ai`。
4. 使用许可及版本、适用的研究/内部评测与再分发权限、知情同意时间/版本、撤回渠道、撤回/保留期限；若涉及未成年人需适用的监护人授权/伦理流程。
5. 单独保管完整授权与联系方式，生成不透明的 `consent_reference`（例如 `registry:submission-001`）。公开/报告只使用该引用与哈希，不能保存姓名到 manifest。
6. Manifest 还需 `id,file,lang,label,source,source_url,license,dataset_revision,domain,split,group_id,training_overlap,training_overlap_evidence`；增加上述六个字段。`authorship_evidence=consented_attestation` **必须**有非空 `consent_reference`，但格式验证不是授权真伪审计；`training_overlap=excluded` 仍须有独立的时间/版本证据。作者/同题/改写关联必须分组，不能重复计为独立样本。

简短模板（需按实际权限与伦理要求完善，并私下签署）：

> 我确认本作品由本人于____至____完成，最早版本为____，是否曾公开/复用及链接____。生成式 AI 的使用情况（生成/改写/翻译/润色等逐项说明，未使用请明确声明）为____；可提供的草稿/版本证据为____。我自愿允许项目按____许可，将此作品用于____范围的检测器评测；是否允许再分发____。我了解模型可能误判，参与不应影响成绩或被用于惩罚。我已了解数据保存至____、访问范围____及通过____撤回的方式，并同意将授权凭据私下保存，以不透明引用关联样本。作者/有权授权人____，日期____；必要时监护人____。

## 不能单独启用中文 paper calibration

本集是 **human-only、test-only** 的来源候选集，不拟合阈值，也不写入运行时配置。需要独立生成并记录模型/版本/提示/时间/权利证据的 AI 对照、预先冻结且组间独立的 calibration/test 划分，默认每类每 split **至少 30 个样本及独立组**（中文 paper 的人类/AI、calibration/test 均需满足），以及真实 `/api/detect` 的模型指纹、置信度和长度范围记录。还必须满足 Wilson 置信上界、训练重叠及运行时 profile 检查。配额不是充分条件；网页作者标签不可靠的问题也必须解决。参见 [benchmark.md](benchmark.md)。

## 2026-11-19 完整采集与真实模型评测（仅汇总，无正文）

- 参数：`--limit-en 40 --limit-zh 40`；接受 77、拒绝 80、配额达到后跳过 43。英文 40 篇 arXiv，中文 37 篇 Hans；2 篇 JTO 缺少可提取全文，另 1 篇 Hans 不满足中文比例。
- Manifest SHA-256：`47ca8d7ff5410afc68b4793283b5620eb2571372234006d0f8a3da9bba4786a0`。相同参数的离线重建得到相同哈希。
- 提取环境：Python 3.11.18、pypdf 7.1.1、fonttools 4.68.0。PDF 曾提示缺少可选 fontTools；安装后从缓存完整重建，manifest 未变。
- `/api/status` 确认两个真实模型均就绪，使用默认阈值、未应用 paper 校准。逐篇调用 `benchmark.run_api`，完整原文不裁切；API 拒绝单独记为弃权。`benchmark.py` 对成功子集及其原始预测汇总为 `report.json`，不是对全部 77 篇均成功评分。

| 语言 | 采集 n | 成功评分 n | low | uncertain | high（来源标签 human → high） | API 弃权（HTTP 400 / too_long） | 低置信度 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| en | 40 | 25 | 11 | 9 | 5 | 15 | 0 |
| zh | 37 | 32 | 7 | 11 | 14 | 5 | 0 |

`uncertain` 是已评分的不确定判定，不与 API 弃权重复相加。错误原因已逐篇核对为 `too_long`；没有扩大 API 限制、删除超长候选或截短后冒充全文结果。误报率及 Wilson 区间只能针对成功评分子集解释，不能推广到被弃权的超长论文；来源标签也不是已核实的纯人工真值。完整 manifest、成功子集 `scored-manifest.jsonl`、预测、API 弃权记录与报告均仅存于私有目录，未提交个体记录或正文。
