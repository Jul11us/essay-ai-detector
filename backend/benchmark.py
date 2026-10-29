"""Provenance-aware local evaluation of the exact /api/detect pipeline.

No essay text or input file paths are written to prediction/report artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

from app.calibration_fit import build_profile, validate_split_groups
from app.evaluation_stats import LABELS, LANGS, summarize


def load_manifest(path: Path) -> list[dict]:
    root = path.resolve().parent
    rows = [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    seen: set[str] = set()
    content_groups: dict[str, tuple[str, str]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Manifest rows must be objects")
        if not all(
            isinstance(row.get(k), str) and row[k].strip()
            for k in ("id", "file", "lang", "label", "source")
        ):
            raise ValueError("Each row needs nonempty id, file, lang, label and source")
        if row["id"] in seen:
            raise ValueError(f"Duplicate id: {row['id']}")
        seen.add(row["id"])
        if row["lang"] not in LANGS or row["label"] not in LABELS:
            raise ValueError(f"Invalid lang or label for {row['id']}")
        for key in (
            "writer_group",
            "domain",
            "group_id",
            "source_url",
            "license",
            "dataset_revision",
        ):
            if key in row and (not isinstance(row[key], str) or not row[key].strip()):
                raise ValueError(f"Invalid {key}: {row['id']}")
        if "training_overlap" in row and row["training_overlap"] not in {
            "excluded",
            "unknown",
            "possible",
        }:
            raise ValueError(f"Invalid training_overlap: {row['id']}")
        if row.get("training_overlap") == "excluded" and not isinstance(
            row.get("training_overlap_evidence"), str
        ):
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
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Benchmark API must be a local HTTP service")
    predictions: list[dict] = []
    with httpx.Client(
        base_url=base_url, timeout=660.0, follow_redirects=False, trust_env=False
    ) as client:
        for row in rows:
            path = row["_path"]
            started = time.perf_counter()
            try:
                with path.open("rb") as stream:
                    response = client.post(
                        "/api/detect",
                        data={"lang": row["lang"]},
                        files={"file": (path.name, stream)},
                    )
            except httpx.HTTPError:
                raise RuntimeError(f"{row['id']}: local API request failed") from None
            elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
            if response.status_code != 200:
                raise RuntimeError(f"{row['id']}: API HTTP {response.status_code}")
            try:
                result = response.json()
                prediction = {
                    "id": row["id"],
                    "score": result["score"],
                    "verdict": result["verdict"],
                    "model_id": result["model_id"],
                    "model_revision": result.get("model_revision", "unknown"),
                    "char_count": result.get("char_count"),
                    "word_count": result.get("word_count"),
                    "confidence": result.get("confidence", "unknown"),
                    "latency_ms": elapsed_ms,
                    "api_pipeline": "/api/detect",
                }
            except (ValueError, KeyError, TypeError):
                raise RuntimeError(f"{row['id']}: invalid API response structure") from None
            predictions.append(prediction)
    return predictions


def load_predictions(path: Path) -> list[dict]:
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


def _save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--predictions",
        type=Path,
        help="Replay JSONL predictions; otherwise call the exact local API",
    )
    parser.add_argument(
        "--predictions-out", type=Path, help="Save safe raw predictions for reproducible replay"
    )
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--calibration-out",
        type=Path,
        help="Fit on calibration split and validate on independent test split",
    )
    parser.add_argument("--max-false-positive-rate", type=float, default=0.20)
    parser.add_argument("--max-false-negative-rate", type=float, default=0.20)
    parser.add_argument("--confidence-level", type=float, default=0.95)
    parser.add_argument("--min-samples-per-class", type=int, default=30)
    args = parser.parse_args()
    rows = load_manifest(args.manifest)
    predictions = (
        load_predictions(args.predictions) if args.predictions else run_api(rows, args.api)
    )
    report = summarize(rows, predictions, confidence_level=args.confidence_level)
    profile = None
    if args.calibration_out:
        profile = build_profile(
            report["records"],
            max_false_positive_rate=args.max_false_positive_rate,
            max_false_negative_rate=args.max_false_negative_rate,
            confidence_level=args.confidence_level,
            min_samples_per_class=args.min_samples_per_class,
        )
        report["calibration"] = {
            "dataset_fingerprint": profile["dataset_fingerprint"],
            "languages": {
                lang: {"status": p["status"], "reasons": p["reasons"]}
                for lang, p in profile["languages"].items()
            },
        }
    if args.predictions_out:
        args.predictions_out.parent.mkdir(parents=True, exist_ok=True)
        safe_predictions = [
            {
                k: r[k]
                for k in (
                    "id",
                    "score",
                    "verdict",
                    "model_id",
                    "model_revision",
                    "char_count",
                    "word_count",
                    "confidence",
                    "latency_ms",
                    "api_pipeline",
                )
            }
            for r in report["records"]
        ]
        args.predictions_out.write_text(
            "".join(
                json.dumps(p, ensure_ascii=False, allow_nan=False) + "\n" for p in safe_predictions
            ),
            encoding="utf-8",
        )
    _save_json(args.out, report)
    if profile is not None:
        _save_json(args.calibration_out, profile)
    print(f"Saved report: {report['overall']['n']} samples")
    if profile is not None:
        print(
            "Calibration: "
            + ", ".join(f"{lang}={p['status']}" for lang, p in profile["languages"].items())
        )


if __name__ == "__main__":
    main()
