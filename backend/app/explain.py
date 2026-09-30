from dataclasses import dataclass

from app.aggregate import HIGH_SCORE, LOW_SCORE, AggregateResult

NEAR_ZERO = 0.001


@dataclass(frozen=True)
class ReviewOutlook:
    risk: str
    label: str
    detail: str


def basis(model_id: str, lang: str) -> str:
    if lang == "zh":
        engine = (
            f"中文用开源模型 {model_id}。它把每一段映射成 0–100% 的模型原始分数，"
            "比较的是用词、句式、节奏是否接近常见大模型输出，不核对事实对错、引用真伪，也看不到你有没有打开过 ChatGPT。"
        )
    else:
        engine = (
            f"英文用本机 Vanguard（{model_id}，ModernBERT）。"
            "训练时见过大量人类文本和模型生成文本，输出一个未在本站作文样本上校准的分数。"
            "依据是写作分布像不像常见 AI 稿，不是「抓到生成记录」，也不是知网 / Turnitin。"
        )
    low, high = round(LOW_SCORE * 100), round(HIGH_SCORE * 100)
    return (
        engine
        + "总分由各段按字数加权，避免只看开头。分数不是文章里 AI 所写的字数比例。"
        + f"本站暂用的经验档位：低于 {low}% 为较低，{low}%–{high}% 为不确定，"
        + f"不低于 {high}% 且文本充分度不是「低」才标较高。这些档位尚未经过真实作文语料校准。"
    )


def reading(result: AggregateResult) -> str:
    if result.score < NEAR_ZERO:
        return (
            "接近 0% 只说明：在本模型看来，这篇更像它训练时见过的人类写法，原始分数小到四舍五入会显示成 0% 或 <0.1%。"
            "这不是「证明是人写的」，也不能保证学校检测器同样给低分。"
            "人写的作业、改过很多遍的 AI 稿、口语化课程反思，都可能接近 0%。"
        )
    if result.verdict == "low":
        return (
            "较低只表示整体更接近人类写作分布，不是无罪证明。"
            "请对照下面各段：若某一段明显高于全文，应单独看那一段的措辞是否过整、过空。"
        )
    if result.verdict == "high":
        return (
            "较高表示模型认为用词和句式更像常见 AI 输出（往往更平滑、模板感更强）。"
            "这仍可能是人写的工整学术腔，也可能是生成后再微调。不要单凭总分认定学术不端，先看高分段在说什么。"
        )
    return (
        "落在不确定区间，说明信号不够一边倒：可能是人写得比较整齐，也可能是 AI 稿夹了改写。"
        "请以各段差异为主，不要把中间分读成「一半是 AI」。"
    )


def review_outlook(result: AggregateResult) -> ReviewOutlook:
    """按分数给出复核提示。只描述这份分数本身，不预测学校检测器或老师会怎么判。

    本站的档位没有经过带真值的作文样本校准，所以没有任何一档有资格说「能过」
    或「大概率不会被查出」。`likely_ok` 只表示本模型没给出高分。
    """
    hot = sum(1 for p in result.paragraphs if p.verdict == "high")
    caveat = (
        "这只按本站开源模型估计，不是学校官方审查，也不能预测 Turnitin / 知网 / GPTZero 的结果。"
    )
    if result.confidence == "low":
        return ReviewOutlook(
            risk="unclear",
            label="作业审查：材料偏短，本站分数不稳",
            detail="文本偏短或段太少，本站分数本身就不稳，不能据此判断任何结果。" + caveat,
        )
    if result.verdict == "high" or hot >= 2:
        return ReviewOutlook(
            risk="likely_flag",
            label="作业审查：高分段较多，建议对照原文复核",
            detail=(
                "按本站分数，全文或至少两段更像常见 AI 写法。请对照高分段回看原文。"
                "也可能只是人写得很整齐，分数不是生成证据。"
            )
            + caveat,
        )
    if result.verdict == "uncertain" or hot == 1 or result.mixed_variance:
        extra = ""
        if hot == 1:
            extra = "有一段明显高于全文，建议先看那一段。"
        elif result.mixed_variance:
            extra = "各段分数差得大，有的像人写、有的更像生成。"
        return ReviewOutlook(
            risk="unclear",
            label="作业审查：信号不一致，请逐段查看",
            detail="本站没有给出一边倒的结果，不能只看总分。" + extra + caveat,
        )
    return ReviewOutlook(
        risk="likely_ok",
        label="作业审查：按本站分数，暂未见明显高分段",
        detail=(
            "本站总分偏低，各段也没有明显高分。这只说明本模型没有给出高分："
            "不是过关证明，也不能预测学校系统或老师的判断，他们可能看内容、引用，口径也可能不同。"
        )
        + caveat,
    )


def explain(result: AggregateResult, model_id: str, lang: str) -> str:
    parts = [basis(model_id, lang), reading(result)]
    if result.mixed_variance:
        parts.append("各段差异大，不宜只看一个总分。")
    if result.confidence == "low":
        parts.append("文本偏短或段少，参考价值有限。")
    return "\n".join(parts)
