"""中文分类头方向自检。

zhv3 的 config.json 没有 id2label，「0=人类、1=AI」全靠代码硬编码。
方向反了不会报错，只会把分数变成 100 减正确值，所以这里要锁住：
明显颠倒就拒绝出分，信号弱但不颠倒就放行（不能因为样本不典型就废掉中文）。
"""

import pytest

from app.sanity import (
    AI_STYLE_ZH,
    HUMAN_STYLE_ZH,
    LabelDirectionError,
    check_zh_direction,
)


def _by_sample(ai_score: float, human_score: float):
    def score(text: str) -> float:
        return ai_score if text == AI_STYLE_ZH else human_score

    return score


def test_accepts_the_measured_direction():
    out = check_zh_direction(_by_sample(0.9994, 0.4591))
    assert out == {"ai_style": 0.9994, "human_style": 0.4591}


def test_weak_but_correct_signal_still_passes():
    """实测《背影》就有 0.4591，不能因为「人写样本分数不低」就判方向反了。"""
    out = check_zh_direction(_by_sample(0.63, 0.55))
    assert out["ai_style"] == 0.63


def test_inverted_labels_are_rejected():
    with pytest.raises(LabelDirectionError):
        check_zh_direction(_by_sample(0.12, 0.97))


def test_probes_are_not_accidentally_identical():
    assert AI_STYLE_ZH != HUMAN_STYLE_ZH
    assert len(AI_STYLE_ZH) > 150
    assert len(HUMAN_STYLE_ZH) > 150
