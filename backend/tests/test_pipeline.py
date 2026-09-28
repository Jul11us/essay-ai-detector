import pytest

from app.errors import DetectError
from app.pipeline import run_detect
from app.scoring import MODEL_IDS


def fake_score(text: str, lang: str) -> float:
    return 0.2 if text.startswith("H") else 0.8


def test_json_happy_path_weighted():
    human = "H" + "h" * 200
    ai = "A" + "a" * 600
    text = human + "\n\n" + ai
    out = run_detect("en", text, None, None, fake_score)
    assert "error" not in out
    assert out["model_id"] == MODEL_IDS["en"]
    assert "Vanguard" in out["explanation"]
    assert out["basis"]
    assert out["reading"]
    assert out["review_risk"] in {"likely_ok", "unclear", "likely_flag"}
    assert out["review_label"]
    w_h, w_a = 201, 601
    expected = (0.2 * w_h + 0.8 * w_a) / (w_h + w_a)
    assert abs(out["score"] - round(expected, 4)) < 1e-9
    assert "知网" in out["explanation"]
    # 前端的「过短的段折叠」依赖这个字段
    assert [p["char_count"] for p in out["paragraphs"]] == [201, 601]
    assert [p["text"][0] for p in out["paragraphs"]] == ["H", "A"]
    assert out["markers"] == []
    assert len(out["rhythm"]["lengths"]) == 2


def test_missing_lang():
    with pytest.raises(DetectError) as ei:
        run_detect(None, "a" * 400, None, None, fake_score)
    assert ei.value.code == "lang_required"


def test_mismatch_english_on_chinese():
    with pytest.raises(DetectError) as ei:
        run_detect("en", "研究" * 120, None, None, fake_score)
    assert ei.value.code == "language_mismatch"



def test_excluded_references_do_not_change_score_or_model_input():
    seen = []
    def score(text, lang):
        seen.append(text)
        return 0.2
    body = "This paragraph describes a local visit with enough detail for the detector. " * 5
    text = body + "\n\nReferences\n\n" + "AI text " * 50
    out = run_detect("en", text, None, None, score)
    assert out["score"] == 0.2
    assert len(seen) == 1
    assert "AI text" not in seen[0]
    assert [item["reason"] for item in out["ignored"]] == ["参考文献", "参考文献"]
