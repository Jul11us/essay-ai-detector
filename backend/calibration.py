"""Fit document decision thresholds; never reinterpret scores as probabilities.

This module is dependency-free and does not load or change the runtime model.
"""
from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_left
from collections import Counter
from datetime import datetime, timezone
from statistics import NormalDist
from urllib.parse import urlsplit


def wilson_interval(count: int, denominator: int, confidence_level: float = 0.95) -> list[float] | None:
    if type(count) is not int or type(denominator) is not int or denominator < 0 or not 0 <= count <= denominator:
        raise ValueError("Wilson counts must be integers with 0 <= count <= denominator")
    if type(confidence_level) not in (int, float) or not math.isfinite(confidence_level) or not 0 < confidence_level < 1:
        raise ValueError("confidence_level must be between 0 and 1")
    if denominator == 0:
        return None
    z = NormalDist().inv_cdf((1 + confidence_level) / 2)
    p = count / denominator
    z2 = z * z
    divisor = 1 + z2 / denominator
    center = (p + z2 / (2 * denominator)) / divisor
    margin = z * math.sqrt(p * (1-p) / denominator + z2 / (4 * denominator**2)) / divisor
    return [0.0 if count == 0 else max(0.0, center - margin),
            1.0 if count == denominator else min(1.0, center + margin)]


def validate_split_groups(rows: list[dict], *, require_splits: bool = False) -> None:
    if not rows:
        raise ValueError("No samples")
    has_splits = any("split" in r and r["split"] != "descriptive" for r in rows)
    if not has_splits and not require_splits:
        return
    group_splits: dict[str, str] = {}
    for row in rows:
        split, group = row.get("split"), row.get("group_id")
        if split not in {"calibration", "test"} or not isinstance(group, str) or not group.strip():
            raise ValueError("Calibration requires split=calibration/test and nonempty group_id for every sample")
        if group in group_splits and group_splits[group] != split:
            raise ValueError("Group leakage: an original and its human/AI/mixed versions cannot cross calibration/test splits")
        group_splits[group] = split


def document_verdict(score: float, confidence: str, low: float, high: float) -> str:
    if score < low:
        return "low"
    if score >= high and confidence != "low":
        return "high"
    return "uncertain"


def _rate(count: int, denominator: int, level: float) -> dict:
    return {"count": count, "of": denominator, "rate": count / denominator if denominator else None,
            "wilson_ci": wilson_interval(count, denominator, level)}


def threshold_metrics(records: list[dict], low: float, high: float, level: float = 0.95) -> dict:
    human = [r for r in records if r["label"] == "human"]
    ai = [r for r in records if r["label"] == "ai"]
    mixed = [r for r in records if r["label"] == "mixed"]
    verdict = lambda r: document_verdict(r["score"], r.get("confidence", "unknown"), low, high)
    return {
        "n_binary": len(human) + len(ai),
        "human_high_false_flag": _rate(sum(verdict(r) == "high" for r in human), len(human), level),
        "ai_low_miss": _rate(sum(verdict(r) == "low" for r in ai), len(ai), level),
        "uncertain": _rate(sum(verdict(r) == "uncertain" for r in human + ai), len(human) + len(ai), level),
        "human_uncertain": _rate(sum(verdict(r) == "uncertain" for r in human), len(human), level),
        "ai_uncertain": _rate(sum(verdict(r) == "uncertain" for r in ai), len(ai), level),
        "mixed_n": len(mixed), "mixed_verdicts": dict(Counter(verdict(r) for r in mixed)),
    }


def _fits_constraints(metrics: dict, max_fp: float, max_fn: float) -> bool:
    fp, fn = metrics["human_high_false_flag"]["wilson_ci"], metrics["ai_low_miss"]["wilson_ci"]
    return fp is not None and fn is not None and fp[1] <= max_fp and fn[1] <= max_fn


def fit_thresholds(records: list[dict], *, max_false_positive_rate: float = 0.20,
                   max_false_negative_rate: float = 0.20, confidence_level: float = 0.95) -> dict | None:
    """Fit only calibration binary samples, minimizing uncertainty under error CIs."""
    if any(r.get("split") != "calibration" for r in records):
        raise ValueError("Threshold fitting accepts only calibration records")
    for r in records:
        score = r.get("score")
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Calibration scores must be finite numbers in 0..1")
    binary = [r for r in records if r["label"] in {"human", "ai"}]
    human = sorted(r["score"] for r in binary if r["label"] == "human" and r.get("confidence", "unknown") != "low")
    ai = sorted(r["score"] for r in binary if r["label"] == "ai")
    n_human = sum(r["label"] == "human" for r in binary)
    if not n_human or not ai:
        return None
    all_scores = sorted(r["score"] for r in binary)
    high_eligible = sorted(r["score"] for r in binary if r.get("confidence", "unknown") != "low")
    grid = sorted({0.0, 1.0} | {r["score"] for r in binary} |
                  {math.nextafter(r["score"], 1.0) for r in binary if r["score"] < 1.0})
    lows, highs = [], []
    for threshold in grid:
        fn = bisect_left(ai, threshold)
        fp = len(human) - bisect_left(human, threshold)
        if wilson_interval(fn, len(ai), confidence_level)[1] <= max_false_negative_rate:
            lows.append((threshold, bisect_left(all_scores, threshold), fn))
        if wilson_interval(fp, n_human, confidence_level)[1] <= max_false_positive_rate:
            highs.append((threshold, len(high_eligible) - bisect_left(high_eligible, threshold), fp))
    best = None
    for low, n_low, fn in lows:
        for high, n_high, fp in highs:
            if low >= high:
                continue
            uncertain = len(binary) - n_low - n_high
            # Stable tie-break: fewer errors, wider uncertainty band, numeric order.
            key = (uncertain, fp + fn, -(high-low), low, high)
            if best is None or key < best[0]:
                best = (key, low, high)
    if best is None:
        return None
    low, high = best[1:]
    return {"low": low, "high": high, "metrics": threshold_metrics(records, low, high, confidence_level)}


def _sample_counts(records: list[dict]) -> dict:
    labels = Counter(r["label"] for r in records)
    return {"human": labels["human"], "ai": labels["ai"], "mixed": labels["mixed"],
            "groups": len({r["group_id"] for r in records}),
            "groups_by_label": {label: len({r["group_id"] for r in records if r["label"] == label}) for label in ("human", "ai", "mixed")}}


def _validate_records(records: list[dict]) -> None:
    validate_split_groups(records, require_splits=True)
    seen = set()
    digests: dict[str, tuple[str, str]] = {}
    for r in records:
        if not isinstance(r.get("id"), str) or not r["id"] or r["id"] in seen:
            raise ValueError("Calibration sample ids must be nonempty and unique")
        seen.add(r["id"])
        if r.get("lang") not in {"en", "zh"} or r.get("label") not in {"human", "ai", "mixed"}:
            raise ValueError("Invalid calibration language or label")
        score = r.get("score")
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Calibration scores must be finite numbers in 0..1")
        for key in ("model_id", "model_revision"):
            if not isinstance(r.get(key), str) or not r[key].strip():
                raise ValueError(f"Calibration requires {key}")
        if "confidence" in r and (not isinstance(r["confidence"], str) or r["confidence"] not in {"low", "medium", "high", "unknown"}):
            raise ValueError("Invalid calibration confidence")
        for key in ("char_count", "word_count"):
            if r.get(key) is not None and (type(r[key]) is not int or r[key] < 0):
                raise ValueError(f"Invalid calibration {key}")
        digest = r.get("input_sha256")
        if digest:
            previous = digests.get(digest)
            if previous and previous != (r["split"], r["group_id"]):
                raise ValueError("Duplicate input content cannot cross splits or inflate group counts")
            digests[digest] = (r["split"], r["group_id"])
    for lang in {r["lang"] for r in records}:
        models = {(r["model_id"], r["model_revision"]) for r in records if r["lang"] == lang}
        if len(models) != 1:
            raise ValueError(f"Cannot calibrate mixed models/revisions for language {lang}")


def build_profile(records: list[dict], *, max_false_positive_rate: float = 0.20,
                  max_false_negative_rate: float = 0.20, confidence_level: float = 0.95,
                  min_samples_per_class: int = 30) -> dict:
    for value in (max_false_positive_rate, max_false_negative_rate):
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value < 1:
            raise ValueError("Error constraints must be between 0 and 1")
    wilson_interval(0, 0, confidence_level)
    if type(min_samples_per_class) is not int or min_samples_per_class < 1:
        raise ValueError("min_samples_per_class must be a positive integer")
    _validate_records(records)
    fingerprint_keys = ("id", "lang", "label", "split", "group_id", "input_sha256", "source", "source_url", "license", "dataset_revision", "writer_group", "domain", "training_overlap", "training_overlap_evidence")
    fingerprint_rows = [{k: r[k] for k in fingerprint_keys if k in r} for r in sorted(records, key=lambda r: r["id"])]
    fingerprint = hashlib.sha256(json.dumps(fingerprint_rows, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    languages = {}
    for lang in sorted({r["lang"] for r in records}):
        items = [r for r in records if r["lang"] == lang]
        calibration = [r for r in items if r["split"] == "calibration"]
        test = [r for r in items if r["split"] == "test"]
        sample_counts = {"calibration": _sample_counts(calibration), "test": _sample_counts(test)}
        model_id, revision = items[0]["model_id"], items[0]["model_revision"]
        reasons = []
        for split, split_counts in sample_counts.items():
            for label in ("human", "ai"):
                if split_counts[label] == 0:
                    reasons.append(f"{split}: missing {label} class")
                elif min(split_counts[label], split_counts["groups_by_label"][label]) < min_samples_per_class:
                    reasons.append(f"{split}: fewer than {min_samples_per_class} independent {label} samples/groups")
                if split_counts[label] != split_counts["groups_by_label"][label]:
                    reasons.append(f"{split}: repeated {label} versions are statistically correlated")
        if model_id == "unknown" or revision == "unknown":
            reasons.append("model id/revision is unknown")
        if any(r.get("confidence") not in {"low", "medium", "high"} or
               type(r.get("char_count")) is not int or type(r.get("word_count")) is not int for r in items):
            reasons.append("missing exact API confidence/length metadata")
        if any(r.get("api_pipeline") != "/api/detect" for r in items):
            reasons.append("exact /api/detect pipeline provenance is unverified")
        if any(not r.get("source_url") or not r.get("license") for r in items):
            reasons.append("missing source URL/license provenance")
        if any(not r.get("input_sha256") for r in items):
            reasons.append("missing input fingerprints for duplicate/leakage checks")
        if any(r.get("training_overlap") != "excluded" or not isinstance(r.get("training_overlap_evidence"), str) or not r["training_overlap_evidence"].strip() for r in items):
            reasons.append("model training overlap has not been excluded with evidence")
        overlap_status = "excluded" if all(r.get("training_overlap") == "excluded" and isinstance(r.get("training_overlap_evidence"), str) and r["training_overlap_evidence"].strip() for r in items) else "possible" if any(r.get("training_overlap") == "possible" for r in items) else "unknown"
        overlap_evidence = sorted({r["training_overlap_evidence"].strip() for r in items if isinstance(r.get("training_overlap_evidence"), str) and r["training_overlap_evidence"].strip()})
        fitted = fit_thresholds(calibration, max_false_positive_rate=max_false_positive_rate,
                                max_false_negative_rate=max_false_negative_rate, confidence_level=confidence_level) if calibration else None
        if fitted is None:
            reasons.append("no calibration threshold pair meets Wilson error constraints")
        test_metrics = threshold_metrics(test, fitted["low"], fitted["high"], confidence_level) if fitted else None
        if fitted and not _fits_constraints(test_metrics, max_false_positive_rate, max_false_negative_rate):
            reasons.append("independent test Wilson upper bounds do not meet error constraints")
        binary_items = [r for r in items if r["label"] in {"human", "ai"}]
        chars = [r["char_count"] for r in binary_items if type(r.get("char_count")) is int]
        languages[lang] = {
            "model_id": model_id, "model_revision": revision,
            "status": "unvalidated" if fitted is None else "candidate" if reasons else "validated",
            "low": fitted["low"] if fitted else None, "high": fitted["high"] if fitted else None,
            "reasons": reasons, "counts": sample_counts,
            "training_overlap": {"status": overlap_status, "evidence": overlap_evidence},
            "applicability": {"char_count": {"min": min(chars) if chars else None, "max": max(chars) if chars else None},
                              "writer_groups": sorted({r.get("writer_group", "unspecified") for r in binary_items}),
                              "source_domains": sorted({urlsplit(r["source_url"]).hostname for r in items if r.get("source_url")}),
                              "domains": sorted({r.get("domain", "unspecified") for r in items}),
                              "evaluation_unit": "document", "source_scope": "Only the manifest sources and lengths; no unseen author-group, essay-domain, newer-model, paragraph or sentence claim."},
            "calibration_metrics": fitted["metrics"] if fitted else None, "test_metrics": test_metrics,
        }
    return {"schema_version": 1, "profile_version": "thresholds-v1", "generated_at": datetime.now(timezone.utc).isoformat(),
            "dataset_fingerprint": fingerprint, "score_semantics": "raw_model_score_not_authorship_probability",
            "evaluation_unit": "document", "fit_objective": "Minimize calibration binary uncertainty subject to Wilson upper-bound error constraints; mixed and independent test samples never fit thresholds.",
            "policy": {"max_false_positive_rate": max_false_positive_rate, "max_false_negative_rate": max_false_negative_rate,
                       "confidence_level": confidence_level, "min_samples_per_class": min_samples_per_class},
            "languages": languages}
