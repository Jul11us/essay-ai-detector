import pytest

from app.errors import DetectError
from app.length import check_length, count_chars, count_words


def test_count_chars_skips_whitespace():
    assert count_chars("a b\n你") == 3


def test_count_words():
    assert count_words("one  two\nthree") == 3


def test_zh_too_short():
    with pytest.raises(DetectError) as ei:
        check_length("短" * 149, "zh")
    assert ei.value.code == "too_short"


def test_zh_ok_at_150():
    check_length("字" * 150, "zh")


def test_zh_too_long():
    with pytest.raises(DetectError) as ei:
        check_length("字" * 10001, "zh")
    assert ei.value.code == "too_long"


def test_en_too_short():
    with pytest.raises(DetectError) as ei:
        check_length("a" * 199, "en")
    assert ei.value.code == "too_short"


def test_en_too_long_by_words():
    text = " ".join(["word"] * 8001)
    with pytest.raises(DetectError) as ei:
        check_length(text, "en")
    assert ei.value.code == "too_long"
