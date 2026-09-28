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
    assert "较不易被判高" in outlook.label


def test_review_outlook_high_is_likely_flag():
    outlook = review_outlook(_result(score=0.8, verdict="high", confidence="medium"))
    assert outlook.risk == "likely_flag"
    assert "较可能被盯" in outlook.label


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
    assert "不好说" in outlook.label
