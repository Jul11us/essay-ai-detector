from app.bilingual import run_bilingual, split_by_script
from app.errors import DetectError
import pytest


def score(text: str, lang: str) -> float:
    return 0.2 if lang == "en" else 0.7


EN = "This abstract discusses climate policy and local evidence in plain detail. " * 4
ZH = "本文讨论气候政策与地方证据，篇幅足够单独打分。" * 4


def test_split_keeps_each_language():
    en, zh = split_by_script(EN + "\n\n" + ZH)
    assert "climate" in en
    assert "气候" in zh
    assert "气候" not in en


def test_manual_blocks_are_scored_separately():
    out = run_bilingual(None, EN, ZH, None, None, score)
    assert out["lang"] == "bi"
    assert out["en"]["lang"] == "en"
    assert out["en"]["score"] == 0.2
    assert out["zh"]["lang"] == "zh"
    assert out["zh"]["score"] == 0.7
    assert "不会混成一个总分" in out["note"]


def test_mixed_paste_is_split_before_scoring():
    out = run_bilingual(EN + "\n" + ZH, None, None, None, None, score)
    assert out["en"]["score"] == 0.2
    assert out["zh"]["score"] == 0.7


def test_short_side_is_reported_without_dropping_the_other():
    out = run_bilingual(None, EN, "太短", None, None, score)
    assert out["en"]["score"] == 0.2
    assert out["zh"]["error"] == "section_too_short"


def test_both_sides_too_short_fails_the_request():
    with pytest.raises(DetectError) as ei:
        run_bilingual(None, "too short", "太短", None, None, score)
    assert ei.value.code == "section_too_short"
