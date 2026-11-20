"""Conservative document-only guards; paragraph and sentence scores stay raw."""
from collections.abc import Callable
from dataclasses import replace
from statistics import median

from app.aggregate import AggregateResult
from calibration import DEFAULT_HIGH, DEFAULT_LOW


def guard_verdict(
    result: AggregateResult, lang: str, calibration: dict, genre: str | None,
    sentence_reviews: Callable[[], list[dict]],
) -> tuple[AggregateResult, dict | None]:
    if result.verdict != "high":
        return result, None
    reason = None
    if (lang == "zh" and genre != "paper" and not calibration["applied"]
            and calibration["low"] == DEFAULT_LOW and calibration["high"] == DEFAULT_HIGH
            and result.confidence == "medium" and result.score < .925):
        reason = {
            "code": "zh_medium_high_guard", "observed": result.score, "threshold": .925,
            "note": "中文默认非论文检测：中等充分度的全文分数未达 92.5%，保守降为不确定；原始分数和段落档位不变。",
        }
    elif lang == "en":
        scores = [s["score"] for p in sentence_reviews() for s in p["sentences"] if s["score"] is not None]
        value = median(scores) if scores else None
        if value is None or value < .30:
            reason = {
                "code": "en_sentence_median_guard", "observed": value, "threshold": .30,
                "scored_sentences": len(scores),
                "note": "英文逐句复核的分数中位数未达 30%（或没有可评分句子），全文保守降为不确定；原始分数和段落档位不变。",
            }
    if reason is None:
        return result, None
    return replace(result, verdict="uncertain"), dict(reason, original_verdict="high", verdict="uncertain")
