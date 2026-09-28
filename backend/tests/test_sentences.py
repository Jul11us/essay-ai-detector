from app.errors import DetectError
from app.pipeline import run_sentences
import pytest


def score(text: str, lang: str) -> float:
    return 0.91 if "AI" in text else 0.12


def test_highlights_only_the_suspicious_sentence():
    text = "AI wrote this whole sentence here. Humans vary the next sentence a lot."
    out = run_sentences("en", text, score)
    assert out["capped"] is False
    assert out["sentences"][0]["highlight"] == "high"
    assert out["sentences"][0]["score"] == 0.91
    # 单句 0.12、带上下文 0.91（窗口里有 AI 句）→ 取低的 0.12，邻句不被染高
    assert out["sentences"][1]["highlight"] is None
    assert out["sentences"][1]["score"] == 0.12


def test_short_fragment_is_kept_but_not_scored():
    text = "Wait. AI wrote a sentence that is definitely long enough to score."
    out = run_sentences("en", text, score)
    assert out["sentences"][0]["text"] == "Wait."
    assert out["sentences"][0]["score"] is None
    assert out["sentences"][1]["highlight"] == "high"


def test_empty_sentence_request():
    with pytest.raises(DetectError) as ei:
        run_sentences("en", "  ", score)
    assert ei.value.code == "empty"


def test_does_not_require_full_essay_length():
    text = "AI wrote this one sentence only today."
    out = run_sentences("en", text, score)
    assert out["sentences"][0]["score"] == 0.91


def test_context_vetoes_a_noisy_single_sentence():
    # 单独打分时误判为 AI，但放回上下文里模型不认为像。
    def noisy(text, lang):
        if text == "We got a B plus, which felt like a win.":
            return 0.95
        return 0.2

    text = "I hate group projects so much. We got a B plus, which felt like a win. Dan never showed up."
    rows = run_sentences("en", text, noisy)["sentences"]
    assert rows[1]["score"] == 0.2
    assert rows[1]["highlight"] is None


def test_lone_ai_sentence_stays_above_its_human_neighbours():
    text = (
        "My uncle fixed bikes all summer long. "
        "AI generated this polished sentence right here. "
        "Then a kid laughed at me outside the shop."
    )
    rows = run_sentences("en", text, score)["sentences"]
    assert rows[1]["score"] > rows[0]["score"]
    assert rows[1]["score"] > rows[2]["score"]


def test_batch_scorer_gets_every_query_once():
    calls: list[list[str]] = []

    def many(texts, lang):
        calls.append(list(texts))
        return [score(t, lang) for t in texts]

    def single(text, lang):
        raise AssertionError("有批量打分时不该逐条调用")

    text = "AI wrote this one sentence only today."
    out = run_sentences("en", text, single, score_many=many)
    # 只有一句：单句和「带上下文」是同一段文本，只送一次。
    assert calls == [[text]]
    assert out["sentences"][0]["score"] == 0.91


def test_zh_context_joins_without_spaces():
    seen: list[str] = []

    def many(texts, lang):
        seen.extend(texts)
        return [0.5] * len(texts)

    run_sentences("zh", "第一句写得比较长一些。第二句也写得比较长。", score, score_many=many)
    assert "第一句写得比较长一些。第二句也写得比较长。" in seen


def test_caps_at_max_sentences():
    from app.sentences import MAX_SENTENCES

    text = " ".join(f"Sentence number {i} is long enough." for i in range(MAX_SENTENCES + 3))
    out = run_sentences("en", text, score)
    assert out["capped"] is True
    scored = [r for r in out["sentences"] if r["score"] is not None]
    assert len(scored) == MAX_SENTENCES


def test_batch_length_mismatch_is_infer_failure():
    with pytest.raises(DetectError) as ei:
        run_sentences("en", "AI wrote this one sentence only.", score, score_many=lambda t, l: [])
    assert ei.value.code == "infer_failed"



def test_sentence_observations_are_labeled_as_observations():
    out = run_sentences(
        "en",
        "We delve into this topic with enough words for the sentence model.",
        lambda text, lang: 0.8,
    )
    phrases = [item["phrase"] for item in out["sentences"][0]["observations"]]
    assert "delve into" in phrases
