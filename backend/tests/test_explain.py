from app.aggregate import AggregateResult, ParagraphScore
from app.explain import explain, review_outlook


def _result(**kwargs):
    base = dict(
        score=0.5,
        verdict="uncertain",
        confidence="medium",
        mixed_variance=False,
        char_count=800,
        word_count=100,
        paragraphs=(ParagraphScore(0, "hello", 0.5, "uncertain", char_count=5),),
    )
    base.update(kwargs)
    return AggregateResult(**base)


def test_explain_english_mentions_vanguard():
    text = explain(_result(), "ShantanuT01/vanguard-ai-text-detector", "en")
    assert "ShantanuT01/vanguard-ai-text-detector" in text
    assert "Vanguard" in text
    assert "知网" in text
    assert "Turnitin" in text
    assert "写作分布" in text


def test_zero_score_is_not_proof_of_human():
    text = explain(
        _result(score=0.0, verdict="low"),
        "ShantanuT01/vanguard-ai-text-detector",
        "en",
    )
    assert "接近 0%" in text
    assert "不是「证明是人写的」" in text


def test_explain_mixed_and_low():
    text = explain(
        _result(mixed_variance=True, confidence="low"),
        "yuchuantian/AIGC_detector_zhv3",
        "zh",
    )
    assert "各段差异大，不宜只看一个总分" in text
    assert "参考价值有限" in text


def test_review_outlook_low_is_likely_ok():
    outlook = review_outlook(
        _result(
            score=0.12,
            verdict="low",
            confidence="medium",
            paragraphs=(
                ParagraphScore(0, "a" * 40, 0.1, "low", char_count=40),
                ParagraphScore(1, "b" * 40, 0.12, "low", char_count=40),
            ),
        )
    )
    assert outlook.risk == "likely_ok"
    assert "暂未见明显高分段" in outlook.label


def test_review_outlook_high_is_likely_flag():
    outlook = review_outlook(_result(score=0.8, verdict="high", confidence="medium"))
    assert outlook.risk == "likely_flag"
    assert "建议对照原文复核" in outlook.label


def test_review_outlook_one_hot_paragraph_is_unclear():
    outlook = review_outlook(
        _result(
            score=0.35,
            verdict="low",
            confidence="medium",
            mixed_variance=True,
            paragraphs=(
                ParagraphScore(0, "a" * 40, 0.2, "low", char_count=40),
                ParagraphScore(1, "b" * 40, 0.8, "high", char_count=40),
            ),
        )
    )
    assert outlook.risk == "unclear"
    assert "信号不一致" in outlook.label


# 这些档位没有真值样本校准，文案不能替学生预测「会不会被查出 / 能不能过」。
_PREDICTIONS = ("大概率", "较不易被判", "能过", "会被问", "被盯", "不会被")


def test_review_outlook_never_predicts_what_a_checker_will_do():
    cases = [
        _result(score=0.1, verdict="low", confidence="medium"),
        _result(score=0.5, verdict="uncertain", confidence="medium"),
        _result(score=0.9, verdict="high", confidence="medium"),
        _result(score=0.9, verdict="high", confidence="low"),
    ]
    for case in cases:
        outlook = review_outlook(case)
        for phrase in _PREDICTIONS:
            assert phrase not in outlook.label, (phrase, outlook.label)
            assert phrase not in outlook.detail, (phrase, outlook.detail)


def test_basis_quotes_the_shared_thresholds():
    from app.aggregate import HIGH_SCORE, LOW_SCORE
    from app.explain import basis

    text = basis("yuchuantian/AIGC_detector_zhv3", "zh")
    assert f"{round(LOW_SCORE * 100)}%" in text
    assert f"{round(HIGH_SCORE * 100)}%" in text
