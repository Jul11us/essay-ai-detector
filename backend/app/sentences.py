"""把一段切成句子，供单句打分。切分本身不跑模型。"""

from __future__ import annotations

import re

_BLOCKS = re.compile(r"\n+")
_END = re.compile(r"(?<=[。！？!?；;])\s*|(?<=[.!?])\s+")
# 「Dr. Smith」这类缩写不该在句点处被切断。
_ABBREV_END = re.compile(
    r"(?:^|\s)(?:e\.g|i\.e|mr|mrs|ms|dr|prof|vs|etc|fig|eq)\.$",
    re.I,
)

# 一段里最多跑这么多句。整篇逐句打分时每个评分单元都要过一遍；
# 单元上限是中文 800 字 / 英文 1200 字符，正常不会超过这个数。
MAX_SENTENCES = 40
MIN_SENTENCE_CHARS = 8
HIGHLIGHT_HIGH = 0.75
HIGHLIGHT_MID = 0.60


def split_sentences(text: str) -> list[str]:
    parts: list[str] = []
    for block in _BLOCKS.split(text.replace("\r\n", "\n")):
        bits = [bit.strip() for bit in _END.split(block) if bit.strip()]
        parts.extend(_merge_abbreviations(bits))
    return parts


def _merge_abbreviations(parts: list[str]) -> list[str]:
    merged: list[str] = []
    for part in parts:
        if merged and _ABBREV_END.search(merged[-1]):
            merged[-1] = f"{merged[-1]} {part}"
        else:
            merged.append(part)
    return merged


def highlight_level(score: float) -> str | None:
    if score >= HIGHLIGHT_HIGH:
        return "high"
    if score >= HIGHLIGHT_MID:
        return "mid"
    return None
