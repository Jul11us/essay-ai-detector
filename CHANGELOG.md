# 更新记录 / Changelog

## 2026-10-08

- **本机任务**：任务中心新增「清空全部本机任务」（需确认，不能撤销，有任务运行时不可用），一次清掉保存在浏览器里的全部原文、原文件、结果与批注。
- **文档**：README 拆成简短总览，完整功能说明移到 `docs/features.md` / `docs/features.en.md`。
- **内部整理**：校准拟合和评测统计移入 `app` 包，后端不再依赖运行时的工作目录；没有功能变化。

## 2026-10-03

- **批量检测**：自动识别中英文及混合文档，失败重试、取消后继续、筛选和排序；局部重测结果随对应文件保留。
- **评测与校准**：带标签样本清单、公开 HC3 语料准备工具、来源与组别统计、置信区间、校准／测试分组隔离，以及独立验证后的全文阈值配置。
- **可视化与报告**：样本评测面板、可编辑 Word 标注报告，支持中英合并、原生评论和人工复核记录。
- **Writing Lens 体验**：重新设计输入区与结果层级、紧凑语言切换、原文上下文侧栏、手机复核抽屉、批注自动保存和撤销。
- **本机任务与范围**：上传后选择评分段落，核对文件指纹；任务搜索、筛选、排序、重命名和刷新后手动恢复。
- **版本与过程**：命名保存、文字增删与分数对比、旧稿恢复；实际操作时间线可查看历史批注与稿件。各结果保留 20 份快照和最多 200 个时间线节点。

检测仍在本机运行，分数是模型估计。时间线记录本站操作，不追踪外部写作；本次更新不代表学生作文准确率已获独立验证。

This update adds batch recovery, labelled evaluation and calibration tools, an evaluation dashboard, Word annotation reports, the Writing Lens interface, scoped detection, local task persistence, version comparison and a writing-operation timeline. Inference remains local. Model scores are estimates; the timeline records in-app actions rather than external writing or authorship proof.
