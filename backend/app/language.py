import re

from app.errors import DetectError

_CJK = re.compile(r"[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\U00020000-\U0002A6DF]")
_LATIN = re.compile(r"[A-Za-z]")


def suggest_language(text: str) -> str | None:
    """An input hint over the entire extracted file, before preview truncation."""
    han = len(_CJK.findall(text))
    latin = len(_LATIN.findall(text))
    if han >= 20 and latin >= 40 and min(han, latin) / max(han, latin) >= 0.16:
        return "bi"
    if han >= 12 and han > latin * 0.4:
        return "zh"
    if latin >= 40 and latin > han * 2:
        return "en"
    return None


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
