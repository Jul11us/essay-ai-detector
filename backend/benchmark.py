"""Provenance-aware local evaluation of the exact /api/detect pipeline.

No essay text or input file paths are written to prediction/report artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from calibration import build_profile, validate_split_groups, wilson_interval

LABELS = {"human", "ai", "mixed"}
LANGS = {"en", "zh"}
VERDICTS = {"low", "uncertain", "high"}
CONFIDENCES = {"low", "medium", "high", "unknown"}


def load_manifest(path: Path) -> list[dict]:
    root = path.resolve().parent
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    seen: set[str] = set()
    content_groups: dict[str, tuple[str, str]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Manifest rows must be objects")
        if not all(isinstance(row.get(k), str) and row[k].strip() for k in ("id", "file", "lang", "label", "source")):
            raise ValueError("Each row needs nonempty id, file, lang, label and source")
        if row["id"] in seen:
            raise ValueError(f"Duplicate id: {row['id']}")
        seen.add(row["id"])
        if row["lang"] not in LANGS or row["label"] not in LABELS:
            raise ValueError(f"Invalid lang or label for {row['id']}")
        for key in ("writer_group", "domain", "group_id", "source_url", "license", "dataset_revision"):
            if key in row and (not isinstance(row[key], str) or not row[key].strip()):
                raise ValueError(f"Invalid {key}: {row['id']}")
        if "training_overlap" in row and row["training_overlap"] not in {"excluded", "unknown", "possible"}:
            raise ValueError(f"Invalid training_overlap: {row['id']}")
        if row.get("training_overlap") == "excluded" and not isinstance(row.get("training_overlap_evidence"), str):
            raise ValueError(f"Excluded training overlap requires evidence: {row['id']}")
        if "source_url" in row:
            parsed = urlsplit(row["source_url"])
            if parsed.scheme not in {"https", "http"} or not parsed.hostname:
                raise ValueError(f"source_url must be a public HTTP(S) provenance URL: {row['id']}")
        item = (root / row["file"]).resolve()
        if not item.is_relative_to(root) or not item.is_file():
            raise ValueError(f"File must exist under the manifest directory: {row['id']}")
        if item.suffix.lower() not in {".txt", ".docx", ".pdf"}:
            raise ValueError(f"Unsupported file type: {row['id']}")
        digest = hashlib.sha256(item.read_bytes()).hexdigest()
        if "text_sha256" in row and row["text_sha256"] != digest:
            raise ValueError(f"text_sha256 mismatch: {row['id']}")
        if digest in content_groups:
            old_split, old_group = content_groups[digest]
            if old_split != row.get("split", "descriptive"):
                raise ValueError("Identical input content cannot cross calibration/test splits")
            if old_group != row.get("group_id", row["id"]):
                raise ValueError("Duplicate input content cannot inflate independent group counts")
        content_groups[digest] = (row.get("split", "descriptive"), row.get("group_id", row["id"]))
        row["_path"] = item
        row["_sha256"] = digest
    if not rows:
        raise ValueError("Manifest is empty")
    validate_split_groups(rows)
    return rows


def run_api(rows: list[dict], base_url: str) -> list[dict]:
    import httpx

    parsed = urlsplit(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.username or parsed.password:
        raise ValueError("Benchmark API must be a local HTTP service")
    predictions: list[dict] = []
    with httpx.Client(base_url=base_url, timeout=660.0, follow_redirects=False, trust_env=False) as client:
        for row in rows:
            path = row["_path"]
            started = time.perf_counter()
            try:
                with path.open("rb") as stream:
                    response = client.post("/api/detect", data={"lang": row["lang"]}, files={"file": (path.name, stream)})
            except httpx.HTTPError:
                raise RuntimeError(f"{row['id']}: local API request failed") from None
            elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
            if response.status_code != 200:
                raise RuntimeError(f"{row['id']}: API HTTP {response.status_code}")
            try:
                result = response.json()
                prediction = {
                    "id": row["id"], "score": result["score"], "verdict": result["verdict"],
                    "model_id": result["model_id"], "model_revision": result.get("model_revision", "unknown"),
                    "char_count": result.get("char_count"), "word_count": result.get("word_count"),
                    "confidence": result.get("confidence", "unknown"), "latency_ms": elapsed_ms,
                    "api_pipeline": "/api/detect",
                }
            except (ValueError, KeyError, TypeError):
                raise RuntimeError(f"{row['id']}: invalid API response structure") from None
            predictions.append(prediction)
    return predictions


def load_predictions(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


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


def _save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--predictions", type=Path, help="Replay JSONL predictions; otherwise call the exact local API")
    parser.add_argument("--predictions-out", type=Path, help="Save safe raw predictions for reproducible replay")
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--calibration-out", type=Path, help="Fit on calibration split and validate on independent test split")
    parser.add_argument("--max-false-positive-rate", type=float, default=0.20)
    parser.add_argument("--max-false-negative-rate", type=float, default=0.20)
    parser.add_argument("--confidence-level", type=float, default=0.95)
    parser.add_argument("--min-samples-per-class", type=int, default=30)
    args = parser.parse_args()
    rows = load_manifest(args.manifest)
    predictions = load_predictions(args.predictions) if args.predictions else run_api(rows, args.api)
    report = summarize(rows, predictions, confidence_level=args.confidence_level)
    profile = None
    if args.calibration_out:
        profile = build_profile(report["records"], max_false_positive_rate=args.max_false_positive_rate,
                                max_false_negative_rate=args.max_false_negative_rate, confidence_level=args.confidence_level,
                                min_samples_per_class=args.min_samples_per_class)
        report["calibration"] = {"dataset_fingerprint": profile["dataset_fingerprint"],
                                 "languages": {lang: {"status": p["status"], "reasons": p["reasons"]} for lang, p in profile["languages"].items()}}
    if args.predictions_out:
        args.predictions_out.parent.mkdir(parents=True, exist_ok=True)
        safe_predictions = [{k: r[k] for k in ("id", "score", "verdict", "model_id", "model_revision", "char_count", "word_count", "confidence", "latency_ms", "api_pipeline")} for r in report["records"]]
        args.predictions_out.write_text("".join(json.dumps(p, ensure_ascii=False, allow_nan=False) + "\n" for p in safe_predictions), encoding="utf-8")
    _save_json(args.out, report)
    if profile is not None:
        _save_json(args.calibration_out, profile)
    print(f"Saved report: {report['overall']['n']} samples")
    if profile is not None:
        print("Calibration: " + ", ".join(f"{lang}={p['status']}" for lang, p in profile["languages"].items()))


if __name__ == "__main__":
    main()
