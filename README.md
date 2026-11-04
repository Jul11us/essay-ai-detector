<div align="center">
  <img src="docs/assets/logo.svg" alt="作文 AI 写作检测标志" width="86" />
  <h1>作文 AI 写作检测</h1>
  <p>在本机查看中英文文本的模型评分，并逐句检查值得复核的段落。</p>
  <p><strong>本地预览 · 尚未部署在线服务 · 分数尚未校准</strong></p>
  <p>
    <a href="docs/README.en.md">English</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="docs/features.md">功能说明</a> ·
    <a href="docs/benchmark.md">评测说明</a> ·
    <a href="docs/local-development.md">开发说明</a> ·
    <a href="CHANGELOG.md">更新记录</a>
  </p>
</div>

![Writing Lens：逐句复核、上下文侧栏和自动保存批注](docs/assets/overview.png)

> 截图来自浏览器功能测试，使用虚构文本和固定测试模型。分数仅演示界面，不是实际模型表现或准确率，也不代表已知真实标签。

## 这个项目做什么

这是一个仍在开发中的**本机网站**。它接收粘贴文本或上传的作文，提取正文后调用本地模型，给出英文、中文或中英分开检测的写作倾向，并让你回到原文逐段核对。检测过程在本机运行，正文不会发送给第三方评分接口。

- **输入**：粘贴文本，或上传 `.txt`、`.docx`（读正文和表格）、文字版 PDF；上传后先预览，可选择要评分的段落。
- **阅读结果**：总分、段落与句子着色、全文构成、连续高分区段，以及常见套话和句长波动提示。
- **批量检测**：一次最多 20 个文件，逐篇识别语言，失败可重试、可取消，结果汇总成表。
- **复核**：固定侧栏阅读前后文，标记复核状态，批注自动保存。
- **导出**：Word 标注报告、HTML、JSON、CSV，或打印。
- **版本、时间线、任务中心**：段落重测自动留档并对比；操作过程可回看；任务保存在本机浏览器，刷新后可恢复。
- **样本评测与校准**：用带标签和来源的样本评估误报、漏报和不确定比例；候选阈值未通过独立验证不会启用。

每项功能的细节、限制和界面截图见 [功能说明](docs/features.md)。

## 如何看待分数

模型输出反映的是**写作倾向**，不能当作“AI 写了百分之多少字”、学生是否违规或学校审查结论。逐句着色和“全文构成”使用的是项目当前的展示门槛；门槛尚未经过充分的人类作文、AI 作文和混合作文真值样本验证。短文、非母语英语、改写文本及跨领域材料尤其需要人工复核。

已提供可复现的公开中英文问答试评和校准流程，但**尚无能证明学生作文准确率的独立评测**。公开问答、旧版 ChatGPT、未知作者组别和未排除的模型训练重叠都限制了结果的适用范围；候选阈值须通过独立测试与来源证据核查才可启用。流程与限制见 [评测说明](docs/benchmark.md) 和 [公开语料说明](docs/benchmark-dataset.md)。本仓库也尚未加入用户登录、次数限制或收费功能。

## 快速开始

需要 Windows、Python 3.11+ 和 Node.js 20.19+。首次安装依赖与下载模型需要联网，模型权重不会提交到 GitHub。以下命令在项目根目录的 PowerShell 中执行：

```powershell
py -3 -m venv .venv-detector
.\.venv-detector\Scripts\python.exe -m pip install -r backend\requirements.txt
npm --prefix frontend ci
.\.venv-detector\Scripts\python.exe experiments\download_model.py
.\打开.bat
```

**不想装 Python 和 Node？** 用 Docker：见 [Docker 运行说明](docs/docker.md)。

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，等页面显示“英文可用”再检测。中文模型会在首次启动时下载；不用时双击 `停止.bat` 停止本地服务。模型下载耗时及磁盘占用取决于你的网络和设备。

## 项目结构

```text
backend/      FastAPI 接口、模型加载、评分和测试
frontend/     React 界面
experiments/  模型下载与实验脚本；个人样本留在忽略目录
docs/         演示图片、评测说明和开发文档
scripts/      Windows 启停脚本
```

开发、测试与可选 ONNX 转换命令见 [开发说明](docs/local-development.md)。仓库没有包含虚拟环境、模型权重、私有作文或本机评测结果。**目前是本地预览，尚未发布到线上。**

## 开源状态

项目代码以 [MIT 许可证](LICENSE) 发布。**许可证只覆盖本仓库的代码**：依赖的模型权重（英文 Vanguard、中文 zhv3）不在仓库里，各自遵循其模型页面上的许可证；分数的解读限制见上文“如何看待分数”，不因开源而改变。若要商用或在线提供服务，请单独核对模型条款。
