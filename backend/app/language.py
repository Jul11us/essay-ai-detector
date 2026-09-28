import re

from app.errors import DetectError

_CJK = re.compile(
    r"[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\U00020000-\U0002A6DF]"
)
_LATIN = re.compile(r"[A-Za-z]")


def check_language(text: str, lang: str) -> None:
    cjk = len(_CJK.findall(text))
    latin = len(_LATIN.findall(text))
    denom = cjk + latin
    if denom == 0:
        return
    ratio_cjk = cjk / denom
    if lang == "en" and cjk >= 80 and ratio_cjk > 0.50:
        raise DetectError("language_mismatch")
    if lang == "zh" and latin >= 80 and ratio_cjk < 0.15:
        raise DetectError("language_mismatch")
