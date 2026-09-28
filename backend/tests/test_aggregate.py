from app.aggregate import aggregate, excerpt, paragraph_verdict


def test_weighted_mean():
    a = "x" * 10
    b = "y" * 30
    result = aggregate([a, b], [0.2, 0.8], "en")
    expected = (0.2 * 10 + 0.8 * 30) / 40
    assert abs(result.score - round(expected, 4)) < 1e-9
    assert result.paragraphs[0].verdict == "low"
    assert result.paragraphs[1].verdict == "high"


def test_high_score_low_confidence_is_uncertain():
    p = "a" * 50
    result = aggregate([p], [0.80], "en")
    assert result.confidence == "low"
    assert result.verdict == "uncertain"


def test_high_score_medium_confidence_is_high():
    paras = ["a" * 250, "b" * 250]
    result = aggregate(paras, [0.80, 0.80], "en")
    assert result.confidence in {"medium", "high"}
    assert result.verdict == "high"


def test_mixed_variance_flag():
    paras = ["a" * 200, "b" * 200]
    result = aggregate(paras, [0.1, 0.9], "en")
    assert result.mixed_variance is True


def test_excerpt_ellipsis():
    assert excerpt("x" * 80) == "x" * 80
    assert excerpt("x" * 81) == "x" * 80 + "…"


def test_paragraph_verdict_bands():
    assert paragraph_verdict(0.39) == "low"
    assert paragraph_verdict(0.40) == "uncertain"
    assert paragraph_verdict(0.75) == "high"


def test_paragraph_char_count_matches_the_weight():
    """char_count 必须就是加权用的那个数，前端靠它判断段是不是过短。"""
    a = "x" * 10
    b = "y " * 30
    result = aggregate([a, b], [0.2, 0.8], "en")
    assert result.paragraphs[0].char_count == 10
    assert result.paragraphs[1].char_count == 30  # 空白不计入
