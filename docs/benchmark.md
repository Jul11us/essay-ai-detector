# 作文检测评测基线

这份基线使用网站实际的 `/api/detect` 流程。样本必须有可追溯来源与明确标签；仅凭写作风格猜测的文本不能作为真值。不要把私人作业提交到公开仓库。

## 准备样本

在本机的 `experiments/benchmark-private/` 放入作文文件和 `manifest.jsonl`。该目录已加入 `.gitignore`。每行一篇：

```json
{"id":"essay-001","file":"essay-001.txt","lang":"en","label":"human","source":"作者同意使用的原稿","writer_group":"non_native"}
{"id":"essay-002","file":"essay-002.docx","lang":"en","label":"ai","source":"记录了模型与提示词的生成稿"}
{"id":"essay-003","file":"essay-003.txt","lang":"zh","label":"mixed","source":"保留原稿与 AI 修改记录"}
```

标签只能是 `human`、`ai` 或 `mixed`。记录样本来源、取得许可、文本长度和修改过程；同一原稿的多个版本要放在同一组，不能跨训练与评测集合。英文需单列非英语母语者样本。中英、短文、长文、不同学科分别看结果。

## 运行

先启动本地后端，确认所测语言模型就绪，然后在 `backend/` 下运行：

```powershell
python benchmark.py ../experiments/benchmark-private/manifest.jsonl --out ../experiments/benchmark-private/report.json
```

脚本只向 `127.0.0.1` 或 `localhost` 请求；报告保存样本 ID、来源、标签、模型分数与计数，不保存作文正文。报告分别计数人写稿被判“较高”、AI 稿被判“较低”以及不确定结果。混合稿只报告分布，不伪造二元准确率。样本量、来源和组别必须连同任何性能数字一起报告。

当前仓库没有可公开确认真值的成套作文语料，因此尚无可发布的误判率或经验证阈值。旧的单篇试测只能证明模型可运行。
