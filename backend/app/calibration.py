"""Opt-in document thresholds; default display thresholds stay available on failure."""

from __future__ import annotations

import json
import math
import os
import re
from functools import lru_cache
from pathlib import Path

from app.calibration_fit import wilson_interval

DEFAULT_LOW = 0.40
DEFAULT_HIGH = 0.75


def _reject_constant(value: str):
    raise ValueError("Nonfinite JSON values are unsupported")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite JSON number")
    return number


@lru_cache(maxsize=4)
def _read_profile(path: str, mtime_ns: int, size: int) -> dict:
    if size > 2 * 1024 * 1024:
        raise ValueError("Profile too large")
    profile = json.loads(
        Path(path).read_text(encoding="utf-8"),
        parse_constant=_reject_constant,
        parse_float=_finite_float,
    )
    if (
        not isinstance(profile, dict)
        or type(profile.get("schema_version")) is not int
        or profile.get("schema_version") != 1
    ):
        raise ValueError("Invalid profile schema")
    if profile.get("evaluation_unit") != "document":
        raise ValueError("Only document-level profiles are supported")
    if profile.get("score_semantics") != "raw_model_score_not_authorship_probability":
        raise ValueError("Unsupported score semantics")
    if not isinstance(profile.get("languages"), dict):
        raise ValueError("Missing language profiles")
    return profile


def _verify_validation(profile: dict, item: dict) -> None:
    """Recompute validation constraints rather than trusting a status or saved CI."""
    if item.get("reasons") != []:
        raise ValueError("Unresolved validation reasons")
    overlap = item["training_overlap"]
    evidence = overlap.get("evidence")
    if (
        overlap.get("status") != "excluded"
        or not isinstance(evidence, list)
        or not evidence
        or not all(isinstance(note, str) and note.strip() for note in evidence)
    ):
        raise ValueError("Model training overlap was not excluded")
    policy = profile["policy"]
    minimum = policy["min_samples_per_class"]
    level = policy["confidence_level"]
    if type(minimum) is not int or minimum < 1:
        raise ValueError("Invalid minimum sample count")
    for key in ("max_false_positive_rate", "max_false_negative_rate"):
        target = policy[key]
        if type(target) not in (int, float) or not math.isfinite(target) or not 0 < target < 1:
            raise ValueError("Invalid error constraint")
    for split in ("calibration", "test"):
        counts = item["counts"][split]
        for label in ("human", "ai"):
            count = counts[label]
            independent = counts["groups_by_label"][label]
            if (
                type(count) is not int
                or type(independent) is not int
                or count < minimum
                or independent != count
            ):
                raise ValueError("Insufficient independent samples")
        metrics = item[f"{split}_metrics"]
        for label, metric_key, constraint in (
            ("human", "human_high_false_flag", "max_false_positive_rate"),
            ("ai", "ai_low_miss", "max_false_negative_rate"),
        ):
            metric = metrics[metric_key]
            if metric["of"] != counts[label]:
                raise ValueError("Validation denominator mismatch")
            interval = wilson_interval(metric["count"], metric["of"], level)
            if interval is None or interval[1] > policy[constraint]:
                raise ValueError("Error constraints were not met")


def resolve_calibration(
    lang: str,
    model_id: str,
    revision: str | None,
    char_count: int,
    *,
    scope: str = "document",
) -> dict:
    decision = {
        "status": "default",
        "applied": False,
        "low": DEFAULT_LOW,
        "high": DEFAULT_HIGH,
        "evaluation_unit": "document",
        "note": "尚未启用独立测试通过的整篇阈值；当前使用默认展示门槛。段落和句子着色尚未校准。",
    }
    configured = os.environ.get("DETECTOR_CALIBRATION_PATH")
    if not configured:
        return decision
    defaults = decision.copy()
    try:
        path = Path(configured).resolve()
        stat = path.stat()
        profile = _read_profile(str(path), stat.st_mtime_ns, stat.st_size)
        item = profile["languages"].get(lang)
        if not isinstance(item, dict):
            decision["note"] = "校准文件没有此语言的数据；当前使用默认展示门槛。"
            return decision
        status = item.get("status")
        if status not in {"validated", "candidate", "unvalidated"}:
            raise ValueError("Invalid profile status")
        low, high = item.get("low"), item.get("high")
        if status == "validated" and not (
            type(low) in (int, float)
            and type(high) in (int, float)
            and math.isfinite(low)
            and math.isfinite(high)
            and 0 <= low < high <= 1
        ):
            raise ValueError("Invalid thresholds")
        decision.update(
            {
                "status": status,
                "profile_version": profile.get("profile_version"),
                "dataset_fingerprint": profile.get("dataset_fingerprint"),
                "counts": item.get("counts", {}),
                "applicability": item.get("applicability", {}),
            }
        )
        extent_info = item.get("applicability", {})
        if not isinstance(extent_info, dict) or not isinstance(item.get("counts", {}), dict):
            raise ValueError("Invalid metadata")
        for split_counts in item.get("counts", {}).values():
            if not isinstance(split_counts, dict):
                raise ValueError("Invalid counts metadata")
            for label in ("human", "ai", "mixed"):
                value = split_counts.get(label, 0)
                if type(value) is not int or value < 0:
                    raise ValueError("Invalid class count")
        for name in ("source_domains", "writer_groups"):
            entries = extent_info.get(name, [])
            if not isinstance(entries, list) or not all(
                isinstance(entry, str) for entry in entries
            ):
                raise ValueError("Invalid source metadata")
        if (
            item.get("model_id") != model_id
            or not isinstance(revision, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", revision)
            or item.get("model_revision") != revision
        ):
            decision.update(
                status="unvalidated", note="校准数据与当前模型版本不一致；当前使用默认展示门槛。"
            )
            return decision
        if status != "validated":
            decision["note"] = (
                "候选阈值尚未满足独立测试、样本量或来源核验要求；当前使用默认展示门槛。段落和句子着色尚未校准。"
            )
            return decision
        _verify_validation(profile, item)
        extent = item.get("applicability", {}).get("char_count", {})
        minimum, maximum = extent.get("min"), extent.get("max")
        if type(minimum) is not int or type(maximum) is not int or not 0 <= minimum <= maximum:
            raise ValueError("Invalid applicability")
        if scope != "document":
            decision["note"] = "整篇阈值没有用于单段复检；段落和句子仍使用默认展示门槛。"
            return decision
        if not minimum <= char_count <= maximum:
            decision["note"] = "文本长度超出校准样本范围；当前使用默认展示门槛。"
            return decision
        decision.update(
            applied=True,
            low=low,
            high=high,
            note="整篇档位使用独立测试通过的阈值，仅在所列样本来源与长度范围内验证。分数仍是模型原始分数；段落和句子着色尚未校准。",
        )
    except (OSError, ValueError, TypeError, AttributeError, KeyError, RecursionError):
        decision = {
            **defaults,
            "status": "unvalidated",
            "note": "校准文件无法验证；当前使用默认展示门槛。",
        }
    return decision
