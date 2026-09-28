"""两类分类头的方向自检。

中文模型 `yuchuantian/AIGC_detector_zhv3` 的 `config.json` 没有 `id2label`
（`id2label` 只有 `LABEL_0`/`LABEL_1` 占位），官方「0=人类、1=AI」的口径只靠
`loader.ModelHub._load_softmax` 硬编码。方向猜错不会报错，只会把每个分数变成
`100 - 正确值`，安静地全错。

所以中文加载完先跑一对固定样本：明显 LLM 腔的中文应当明显高于一篇人写的
现代白话文。只有反过来（差到 `INVERSION_MARGIN` 以上）才判定为方向反了并
让中文不可用 —— 宁可不出分，也不出一个方向可疑的分。
"""

from __future__ import annotations

from collections.abc import Callable

# 刻意写成典型 LLM 腔：对举句式 + 首先/其次/再次/综上所述 + 空泛总结。
AI_STYLE_ZH = (
    "在当今社会，人工智能技术的飞速发展正在深刻改变着人们的生产生活方式。"
    "首先，人工智能显著提升了工作效率，使重复性劳动得以自动化处理。"
    "其次，人工智能推动了产业结构的优化升级，催生了大量新兴业态。"
    "再次，人工智能也带来了就业结构的调整，对劳动者的技能提出了新的要求。"
    "综上所述，我们应当以积极而审慎的态度拥抱人工智能，既要充分发挥其赋能作用，"
    "也要通过完善法律法规与伦理规范来防范潜在风险，从而实现科技与人文的协调发展。"
)

# 人写的现代白话文（朱自清《背影》开头，公有领域）。
HUMAN_STYLE_ZH = (
    "我与父亲不相见已二年余了，我最不能忘记的是他的背影。那年冬天，祖母死了，"
    "父亲的差使也交卸了，正是祸不单行的日子，我从北京到徐州，打算跟着父亲奔丧回家。"
    "到徐州见着父亲，看见满院狼藉的东西，又想起祖母，不禁簌簌地流下眼泪。"
    "父亲说，事已如此，不必难过，好在天无绝人之路！回家变卖典质，父亲还了亏空；"
    "又借钱办了丧事。这些日子，家中光景很是惨淡，一半为了丧事，一半为了父亲赋闲。"
)

# 实测参考值（torch 2.14.0+cpu / transformers 4.57.6）：
# AI_STYLE_ZH → 0.9994，HUMAN_STYLE_ZH → 0.4591。
# 0.4591 落在「不确定」档，但**不能**据此说 40% 阈值定错了：宽中间档是刻意的
# （宁可漏判，也不把工整中文直接判成 AI）。《背影》是 1920 年代文学腔，对这个
# 模型属于域外样本，更像中文模型对文学腔偏高。要校准阈值得拿若干篇真作业的
# 人写稿与明确 AI 稿对照，一篇名篇定不了档。
# 这里只关心方向：两者差距远大于 INVERSION_MARGIN。
INVERSION_MARGIN = 0.25


class LabelDirectionError(RuntimeError):
    """中文分类头方向疑似反了。"""


def check_zh_direction(score_fn: Callable[[str], float]) -> dict:
    """跑一对样本，方向明显颠倒就抛错，否则返回实测分数供 /api/status 展示。"""
    ai_score = float(score_fn(AI_STYLE_ZH))
    human_score = float(score_fn(HUMAN_STYLE_ZH))
    if human_score - ai_score >= INVERSION_MARGIN:
        raise LabelDirectionError(
            f"中文分类头方向疑似反了：AI 腔样本 {ai_score:.4f} 低于人写样本 {human_score:.4f}。"
            "代码按「0=人类、1=AI」解析，但这个模型的 config.json 没有 id2label，"
            "请核对标签顺序后再放开中文检测。"
        )
    return {"ai_style": round(ai_score, 4), "human_style": round(human_score, 4)}
