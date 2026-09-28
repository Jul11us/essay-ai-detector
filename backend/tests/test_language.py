import pytest

from app.errors import DetectError
from app.language import check_language


def test_en_with_long_chinese_rejected():
    text = "研究" * 60 + "hello"
    with pytest.raises(DetectError) as ei:
        check_language(text, "en")
    assert ei.value.code == "language_mismatch"


def test_zh_with_long_english_rejected():
    text = "This is an English academic paragraph about markets. " * 8
    with pytest.raises(DetectError) as ei:
        check_language(text, "zh")
    assert ei.value.code == "language_mismatch"


def test_english_essay_with_chinese_name_allowed():
    body = (
        "This paper argues that climate policy needs better data. "
        "Zhang Wei 张三 collected samples in 2019. "
    ) * 6
    check_language(body, "en")


def test_digits_only_not_rejected():
    check_language("1234567890", "en")
