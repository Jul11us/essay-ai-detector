"""点出名篇里的大模型套话，只计数，不改原文。"""

from __future__ import annotations

import re

# 先匹配更长的说法，避免「delve into」再被「delve」算一次。
_EN_PHRASES = (
    "it's important to note",
    "it is important to note",
    "it is worth noting",
    "cannot be overstated",
    "plays a crucial role",
    "plays a pivotal role",
    "in the realm of",
    "in today's digital",
    "in today's rapidly",
    "a testament to",
    "testament to",
    "delve into",
    "delves into",
    "shed light on",
    "pave the way",
    "cutting-edge",
    "ever-evolving",
    "in conclusion",
    "furthermore",
    "moreover",
    "not only",
    "but also",
    "delve",
    "crucial",
    "underscore",
    "underscores",
    "pivotal",
    "tapestry",
    "multifaceted",
    "myriad",
    "leverage",
    "leveraging",
    "intricate",
    "groundbreaking",
    "meticulous",
    "holistic",
    "paradigm",
)

_ZH_PHRASES = (
    "在当今数字化浪潮下",
    "在当今数字化时代",
    "在这个快速发展的时代",
    "随着科技的不断发展",
    "随着社会的不断发展",
    "具有重要里程碑意义",
    "具有重要的现实意义",
    "具有重要意义",
    "值得注意的是",
    "更重要的是",
    "不仅如此",
    "综上所述",
    "总而言之",
    "由此可见",
    "不难发现",
    "毋庸置疑",
    "不可或缺",
    "数字化浪潮",
    "数字时代",
    "在当今",
    "里程碑",
    "至关重要",
    "不可忽视",
    "蓬勃发展",
    "日新月异",
    "全方位",
    "多维度",
    "底层逻辑",
    "赋能",
    "不仅",
    "而且",
)

# 跨几个字的框式套话。命中后占住整段跨度，里面的单词不再单算。
_EN_PATTERNS = (
    ("not only … but also", re.compile(r"not only[^.\n]{0,80}?but also", re.I)),
)
_ZH_PATTERNS = (
    ("不仅……而且", re.compile(r"不仅[^。！？!?\n]{0,48}而且")),
    ("不仅……更", re.compile(r"不仅[^。！？!?\n]{0,48}更")),
)

_MAX_HITS = 24


def _boundary(text: str, start: int, end: int) -> bool:
    if start > 0 and text[start - 1].isalnum():
        return False
    if end < len(text) and text[end].isalnum():
        return False
    return True


def _occupy(flags: list[bool], start: int, end: int) -> bool:
    if any(flags[start:end]):
        return False
    for i in range(start, end):
        flags[i] = True
    return True


def find_markers(text: str, lang: str) -> list[dict]:
    """返回 [{phrase, count}]，按次数从高到低。没有命中就是空列表。"""
    if lang == "en":
        hay = text.lower()
        phrases = _EN_PHRASES
        patterns = _EN_PATTERNS
        use_boundary = True
    else:
        hay = text
        phrases = _ZH_PHRASES
        patterns = _ZH_PATTERNS
        use_boundary = False

    flags = [False] * len(hay)
    counts: dict[str, int] = {}

    for label, pattern in patterns:
        for match in pattern.finditer(hay):
            if _occupy(flags, match.start(), match.end()):
                counts[label] = counts.get(label, 0) + 1

    for phrase in sorted(phrases, key=len, reverse=True):
        needle = phrase.lower() if lang == "en" else phrase
        start = 0
        while True:
            found = hay.find(needle, start)
            if found < 0:
                break
            end = found + len(needle)
            start = found + 1
            if use_boundary and not _boundary(hay, found, end):
                continue
            if not _occupy(flags, found, end):
                continue
            counts[phrase] = counts.get(phrase, 0) + 1
            start = end

    rows = [{"phrase": phrase, "count": count} for phrase, count in counts.items()]
    rows.sort(key=lambda row: (-row["count"], row["phrase"]))
    return rows[:_MAX_HITS]
