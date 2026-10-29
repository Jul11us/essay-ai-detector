"""Describe sentence-length variation without inferring authorship."""

from __future__ import annotations

from app.length import count_chars
from app.sentences import split_sentences

_MAX_POINTS = 180


def measure_rhythm(text: str) -> dict:
    lengths = [count_chars(s) for s in split_sentences(text)]
    lengths = [n for n in lengths if n > 0]
    shown = lengths[:_MAX_POINTS]
    truncated = len(lengths) > _MAX_POINTS
    if len(shown) < 2:
        return {
            "lengths": shown,
            "mean": float(shown[0]) if shown else 0.0,
            "cv": 0.0,
            "label": "句子太少",
            "note": "能切开的句子不足两句，折线说明不了节奏。",
            "truncated": truncated,
        }
    mean = sum(shown) / len(shown)
    var = sum((n - mean) ** 2 for n in shown) / len(shown)
    cv = 0.0 if mean == 0 else (var**0.5) / mean
    if cv < 0.22:
        label = "起伏很小"
        note = (
            "句子长度较为接近，折线起伏较小。"
            "这只描述长度分布，不能判断文字来源，也不是模型分数的因果解释。"
        )
    elif cv < 0.45:
        label = "起伏一般"
        note = "句子长度有一定变化。这个统计只描述长度分布，请结合内容与上下文阅读；它不能解释模型分数。"
    else:
        label = "起伏明显"
        note = "句子长度变化较大，长短句交替比较明显。人写和 AI 文本都可能出现这种变化，不能据此判断来源。"
    return {
        "lengths": shown,
        "mean": round(mean, 1),
        "cv": round(cv, 3),
        "label": label,
        "note": note,
        "truncated": truncated,
    }
