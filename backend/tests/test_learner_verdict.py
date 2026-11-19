from dataclasses import replace
from itertools import product

import pytest

from app.aggregate import aggregate
from app.errors import DetectError
from app.learner_verdict import guard_verdict
from app.pipeline import run_detect

DEFAULT = {"applied": False, "low": .4, "high": .75}
BASE = aggregate(["a" * 400, "b" * 400], [.85, .85], "en")


def review(values):
    return lambda: [{"sentences": [{"score": value} for value in values]}]


@pytest.mark.parametrize("score,expected", [(.75, "uncertain"), (.9249, "uncertain"), (.925, "high"), (1., "high")])
def test_chinese_medium_boundary(score, expected):
    original = replace(BASE, score=score)
    result, reason = guard_verdict(original, "zh", DEFAULT, None, lambda: pytest.fail("Unexpected sentence scoring"))
    assert result.verdict == expected and result.score == score
    assert result.paragraphs == original.paragraphs
    assert (reason is not None) == (expected == "uncertain")
    if reason:
        assert reason["code"] == "zh_medium_high_guard" and reason["threshold"] == .925


@pytest.mark.parametrize("confidence,genre,calibration", [
    ("high", None, DEFAULT), ("low", None, DEFAULT), ("medium", "paper", DEFAULT),
    ("medium", "composition", dict(DEFAULT, applied=True)),
    ("medium", None, dict(DEFAULT, high=.8)),
    ("medium", None, dict(DEFAULT, low=.3)),
])
def test_chinese_exemptions(confidence, genre, calibration):
    original = replace(BASE, confidence=confidence)
    assert guard_verdict(original, "zh", calibration, genre, review([])) == (original, None)


@pytest.mark.parametrize("values,expected", [([.1, None, .2], "uncertain"), ([.3], "high"), ([.2999, .3], "uncertain"), ([.1, .5], "high"), ([], "uncertain"), ([None], "uncertain")])
def test_english_sentence_median(values, expected):
    result, reason = guard_verdict(BASE, "en", DEFAULT, None, review(values))
    assert result.verdict == expected and result.score == BASE.score
    if reason:
        assert reason["code"] == "en_sentence_median_guard"
        assert reason["original_verdict"] == "high" and reason["verdict"] == "uncertain"


def test_only_high_to_uncertain_property():
    for lang, verdict, confidence, genre, applied, score in product(
        ("en", "zh"), ("low", "uncertain", "high"), ("low", "medium", "high"),
        (None, "composition", "paper"), (False, True), (0., .3999, .4, .7499, .75, .9, .925, 1.),
    ):
        original = replace(BASE, score=score, verdict=verdict, confidence=confidence)
        def sentences():
            assert verdict == "high" and lang == "en"
            return review([.1, .2])()
        result, reason = guard_verdict(original, lang, dict(DEFAULT, applied=applied), genre, sentences)
        assert result == original or result == replace(original, verdict="uncertain")
        if result != original:
            assert verdict == "high" and reason is not None
        else:
            assert reason is None


TEXT = "\n\n".join((f"Paragraph {i}. " + "This student explains a personal experience with several concrete details. " * 5) for i in range(2))


def test_pipeline_reuses_ui_reviews_and_preserves_scores():
    batches = []
    def many(queries, lang):
        batches.append(queries)
        return [.1] * len(queries)
    result = run_detect("en", TEXT, None, None, lambda *_: .85, score_many=many)
    assert result["score"] == .85 and result["verdict"] == "uncertain"
    assert result["verdict_adjustment"]["code"] == "en_sentence_median_guard"
    assert result["verdict_adjustment"]["note"] in result["reading"]
    assert len(batches) == len(result["paragraphs"])
    for p in result["paragraphs"]:
        assert p["score"] == .85 and p["verdict"] == "high"
        assert all(s["score"] == .1 for s in p["sentences"] if s["score"] is not None)


@pytest.mark.parametrize("score", [.1, .6])
def test_pipeline_non_high_does_not_score_sentences(score):
    result = run_detect("en", TEXT, None, None, lambda *_: score,
                        score_many=lambda *_: pytest.fail("Unexpected sentence scoring"))
    assert result["verdict_adjustment"] is None
    assert all("sentences" not in p for p in result["paragraphs"])


def test_sentence_failure_is_not_silently_reported_as_high():
    def failed(*_):
        raise RuntimeError("test inference failure")
    with pytest.raises(DetectError) as error:
        run_detect("en", TEXT, None, None, lambda *_: .9, score_many=failed)
    assert error.value.code == "infer_failed"


def test_api_exposes_adjustment_and_cached_sentences(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app, hub
    monkeypatch.setattr(hub, "loaded", {"en": True, "zh": True})
    monkeypatch.setattr(hub, "score", lambda *_: .9)
    monkeypatch.setattr(hub, "score_many", lambda queries, lang: [.1] * len(queries))
    response = TestClient(app).post("/api/detect", json={"lang": "en", "text": TEXT})
    assert response.status_code == 200
    data = response.json()
    assert data["score"] == .9 and data["verdict"] == "uncertain"
    assert data["verdict_adjustment"]["observed"] == .1
    assert all(p["sentences"] for p in data["paragraphs"])
