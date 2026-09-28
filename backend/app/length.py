import re

from app.errors import DetectError

_WS = re.compile(r"\s+", re.UNICODE)


def count_chars(text: str) -> int:
    return len(_WS.sub("", text))


def count_words(text: str) -> int:
    return len(text.split())


def check_length(text: str, lang: str, *, floor: int | None = None) -> None:
    """`floor` 只给中英分开时的摘要用。整篇检测不传，下限仍是中文 150 / 英文 200。"""
    n_chars = count_chars(text)
    short = "section_too_short" if floor is not None else "too_short"
    if lang == "zh":
        minimum = 150 if floor is None else floor
        if n_chars < minimum:
            raise DetectError(short)
        if n_chars > 10000:
            raise DetectError("too_long")
        return
    minimum = 200 if floor is None else floor
    if n_chars < minimum:
        raise DetectError(short)
    if count_words(text) > 8000:
        raise DetectError("too_long")
