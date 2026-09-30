import re

from app.errors import DetectError

_WS = re.compile(r"\s+", re.UNICODE)

# 整篇检测的长度限制。中文按去空白字符数，英文下限按字符数、上限按词数。
ZH_MIN_CHARS = 150
ZH_MAX_CHARS = 10000
EN_MIN_CHARS = 200
EN_MAX_WORDS = 8000
# 单段重测、中英分开时的摘要不套整篇下限，只要求够模型读一读。
SECTION_MIN_CHARS = 20
# 逐句复核一次最多接受的一段长度（去空白字符数）。
SENTENCE_REVIEW_MAX_CHARS = 8000
# 上传预览最多回传多少字符，完整正文不必发给前端。
PREVIEW_MAX_CHARS = 5000


def count_chars(text: str) -> int:
    return len(_WS.sub("", text))


def count_words(text: str) -> int:
    return len(text.split())


def check_length(text: str, lang: str, *, floor: int | None = None) -> None:
    """`floor` 只给中英分开时的摘要用。整篇检测不传，下限仍是中文 150 / 英文 200。"""
    n_chars = count_chars(text)
    short = "section_too_short" if floor is not None else "too_short"
    if lang == "zh":
        minimum = ZH_MIN_CHARS if floor is None else floor
        if n_chars < minimum:
            raise DetectError(short)
        if n_chars > ZH_MAX_CHARS:
            raise DetectError("too_long")
        return
    minimum = EN_MIN_CHARS if floor is None else floor
    if n_chars < minimum:
        raise DetectError(short)
    if count_words(text) > EN_MAX_WORDS:
        raise DetectError("too_long")
