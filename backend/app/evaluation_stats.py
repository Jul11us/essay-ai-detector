"""逐样本评测记录的校验和分组统计（纯函数，不碰文件和网络）。

`benchmark.py` 命令行和 `/api/evaluation/analyze` 共用这里，所以放在 `app` 包里，
不依赖运行时的工作目录。
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timezone

from app.calibration_fit import validate_split_groups, wilson_interval

LABELS = {"human", "ai", "mixed"}
LANGS = {"en", "zh"}
VERDICTS = {"low", "uncertain", "high"}
CONFIDENCES = {"low", "medium", "high", "unknown"}


def make_records(rows: list[dict], predictions: list[dict]) -> list[dict]:
    if not all(isinstance(p, dict) and isinstance(p.get("id"), str) for p in predictions):
        raise ValueError("Predictions must be objects with string ids")
    by_id = {p["id"]: p for p in predictions}
    if len(by_id) != len(predictions) or set(by_id) != {r["id"] for r in rows}:
        raise ValueError("Predictions must contain exactly one record for every manifest id")
    validate_split_groups(rows)
    records = []
    for row in rows:
        p = by_id[row["id"]]
        score = p.get("score")
        if p.get("verdict") not in VERDICTS or type(score) not in (int, float) or not math.isfinite(score):
            raise ValueError(f"Invalid prediction: {row['id']}")
        if not 0 <= score <= 1:
            raise ValueError(f"Score outside 0..1: {row['id']}")
        model_id, revision = p.get("model_id", "unknown"), p.get("model_revision", "unknown")
        if not isinstance(model_id, str) or not model_id.strip() or not isinstance(revision, str) or not revision.strip():
            raise ValueError(f"Invalid model metadata: {row['id']}")
        confidence = p.get("confidence", "unknown")
        if confidence not in CONFIDENCES:
            raise ValueError(f"Invalid confidence: {row['id']}")
        for key in ("char_count", "word_count"):
            value = p.get(key)
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError(f"Invalid {key}: {row['id']}")
        latency = p.get("latency_ms")
        if latency is not None and (type(latency) not in (int, float) or not math.isfinite(latency) or latency < 0):
            raise ValueError(f"Invalid latency_ms: {row['id']}")
        record = {
            "id": row["id"], "lang": row["lang"], "label": row["label"],
            "source": row["source"], "writer_group": row.get("writer_group", "unspecified"),
            "split": row.get("split", "descriptive"), "group_id": row.get("group_id", row["id"]),
            "score": score, "verdict": p["verdict"], "model_id": model_id, "model_revision": revision,
            "char_count": p.get("char_count"), "word_count": p.get("word_count"), "confidence": confidence,
            "confidence_sufficient": None if confidence == "unknown" else confidence != "low",
            "latency_ms": latency, "api_pipeline": p.get("api_pipeline", "unspecified"),
        }
        # Allowlist: never copy file/_path, raw text, API explanations or excerpts.
        for key in ("source_url", "license", "domain", "dataset_revision", "generated_model", "mixed_method", "components", "training_overlap", "training_overlap_evidence"):
            if key in row:
                record[key] = row[key]
        if row.get("_sha256"):
            record["input_sha256"] = row["_sha256"]
        records.append(record)
    return records


def rate(count: int, denominator: int, confidence_level: float = 0.95) -> dict:
    return {"count": count, "of": denominator, "rate": None if denominator == 0 else count / denominator,
            "wilson_ci": wilson_interval(count, denominator, confidence_level)}


def counts(items: list[dict], confidence_level: float = 0.95) -> dict:
    labels = Counter(r["label"] for r in items)
    observed = {label: dict(Counter(r["verdict"] for r in items if r["label"] == label)) for label in sorted(LABELS)}
    return {
        "n": len(items), "groups": len({r["group_id"] for r in items}), "labels": dict(labels), "verdicts_by_label": observed,
        "human_high_false_flag": rate(observed["human"].get("high", 0), labels["human"], confidence_level),
        "ai_low_miss": rate(observed["ai"].get("low", 0), labels["ai"], confidence_level),
        "human_uncertain": rate(observed["human"].get("uncertain", 0), labels["human"], confidence_level),
        "ai_uncertain": rate(observed["ai"].get("uncertain", 0), labels["ai"], confidence_level),
        "uncertain": rate(sum(r["verdict"] == "uncertain" for r in items), len(items), confidence_level),
        "confidence_insufficient": rate(sum(r["confidence"] == "low" for r in items), len(items), confidence_level),
        "confidence_unknown": sum(r["confidence"] == "unknown" for r in items),
        "mixed": observed["mixed"], "mixed_n": labels["mixed"],
        "mixed_verdict_rates": {v: rate(observed["mixed"].get(v, 0), labels["mixed"], confidence_level) for v in sorted(VERDICTS)},
    }


def length_bucket(record: dict) -> str:
    n = record["char_count"]
    if n is None:
        return "unknown"
    return "under_400_chars" if n < 400 else "400_to_1499_chars" if n < 1500 else "1500_plus_chars"


def summarize(rows: list[dict], predictions: list[dict], *, confidence_level: float = 0.95) -> dict:
    records = make_records(rows, predictions)
    groups: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        bucket = length_bucket(record)
        for key in (f"lang:{record['lang']}", f"writer_group:{record['writer_group']}", f"length:{bucket}",
                    f"lang:{record['lang']}|length:{bucket}", f"lang:{record['lang']}|writer_group:{record['writer_group']}",
                    f"split:{record['split']}", f"split:{record['split']}|lang:{record['lang']}",
                    f"split:{record['split']}|lang:{record['lang']}|length:{bucket}",
                    f"split:{record['split']}|lang:{record['lang']}|writer_group:{record['writer_group']}"):
            groups[key].append(record)
    durations = sorted(r["latency_ms"] for r in records if r["latency_ms"] is not None)
    return {
        "schema_version": 2, "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Descriptive counts for these sources and document lengths; raw scores are not authorship probabilities. Mixed writing has no binary ground truth.",
        "interval_note": "Wilson intervals describe sample proportions, not population guarantees. Repeated versions in a group are correlated; inspect group counts and source scope.",
        "confidence_level": confidence_level, "overall": counts(records, confidence_level),
        "groups": {key: counts(items, confidence_level) for key, items in sorted(groups.items())},
        "latency": {"n": len(durations), "mean_ms": sum(durations) / len(durations) if durations else None,
                    "median_ms": (durations[(len(durations)-1)//2] + durations[len(durations)//2]) / 2 if durations else None,
                    "p95_ms": durations[max(0, math.ceil(len(durations) * 0.95)-1)] if durations else None,
                    "scope": "Client end-to-end API request, including upload/extraction/inference; excludes server startup."},
        "records": records,
    }
