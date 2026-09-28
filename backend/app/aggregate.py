from __future__ import annotations

from dataclasses import dataclass
from statistics import pstdev

from app.length import count_chars, count_words


@dataclass(frozen=True)
class ParagraphScore:
    index: int
    excerpt: str
    score: float
    verdict: str
    # 去空白后的字符数，也就是该段在全文里的权重。前端用它判断一段是不是
    # 短到「单独打分不稳定」（题干、标题、残句），从而折叠起来。
    char_count: int


@dataclass(frozen=True)
class AggregateResult:
    score: float
    verdict: str
    confidence: str
    mixed_variance: bool
    char_count: int
    word_count: int
    paragraphs: tuple[ParagraphScore, ...]


def excerpt(text: str, limit: int = 80) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def paragraph_verdict(score: float) -> str:
    if score < 0.40:
        return "low"
    if score >= 0.75:
        return "high"
    return "uncertain"


def aggregate(paragraphs: list[str], probs: list[float], lang: str) -> AggregateResult:
    if len(paragraphs) != len(probs):
        raise ValueError("paragraphs and probs length mismatch")
    weights = [count_chars(p) for p in paragraphs]
    total_w = sum(weights)
    raw = 0.0 if total_w == 0 else sum(p * w for p, w in zip(probs, weights)) / total_w
    score = round(raw, 4)
    std = 0.0 if len(probs) < 2 else pstdev(probs)
    joined = "".join(paragraphs)
    n_chars = count_chars(joined)
    n_words = count_words(joined)
    if n_chars < 400 or len(paragraphs) < 2:
        confidence = "low"
    elif n_chars >= 1500 and std < 0.15:
        confidence = "high"
    else:
        confidence = "medium"
    mixed_variance = std >= 0.25
    if score < 0.40:
        verdict = "low"
    elif score >= 0.75 and confidence != "low":
        verdict = "high"
    else:
        verdict = "uncertain"
    items = tuple(
        ParagraphScore(
            index=i,
            excerpt=excerpt(p),
            score=round(probs[i], 4),
            verdict=paragraph_verdict(probs[i]),
            char_count=weights[i],
        )
        for i, p in enumerate(paragraphs)
    )
    return AggregateResult(
        score=score,
        verdict=verdict,
        confidence=confidence,
        mixed_variance=mixed_variance,
        char_count=n_chars,
        word_count=n_words,
        paragraphs=items,
    )
