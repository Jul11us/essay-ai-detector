from app.rhythm import measure_rhythm
from app.sentences import split_sentences


def test_abbreviation_stays_in_one_sentence():
    parts = split_sentences("Dr. Smith wrote this long enough sentence. Next one is also here.")
    assert parts[0].startswith("Dr. Smith")
    assert len(parts) == 2


def test_flat_sentence_lengths_are_called_out():
    sentence = "这是一句长度完全一样的话。"
    got = measure_rhythm("\n".join([sentence] * 5))
    assert got["label"] == "起伏很小"
    assert got["cv"] < 0.22
    assert len(got["lengths"]) == 5


def test_varied_lengths_are_not_flat():
    text = "短。\n" + ("很长" * 30) + "。"
    got = measure_rhythm(text)
    assert got["label"] == "起伏明显"
    assert got["cv"] >= 0.45


def test_one_sentence_has_no_chart_claim():
    got = measure_rhythm("只有一句，看不出波动。")
    assert got["label"] == "句子太少"
    assert len(got["lengths"]) == 1
