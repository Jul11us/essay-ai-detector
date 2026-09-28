"""句长波动。人写的文章长短句会跳，模型稿常常差不多长。"""

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
    cv = 0.0 if mean == 0 else (var ** 0.5) / mean
    if cv < 0.22:
        label = "起伏很小"
        note = (
            "句长几乎拉成一条水平线：长句和短句拉不开。"
            "这种均匀节奏容易被判成机械生成。可以故意拆开长判断句，或补进短句。"
        )
    elif cv < 0.45:
        label = "起伏一般"
        note = "句长有变化，但还不算大。如果分数偏高，优先改那些又长又整齐的句子。"
    else:
        label = "起伏明显"
        note = "句长波动比较大，更接近人写时长短交替的样子。这只解释节奏，不单独决定分数。"
    return {
        "lengths": shown,
        "mean": round(mean, 1),
        "cv": round(cv, 3),
        "label": label,
        "note": note,
        "truncated": truncated,
    }
