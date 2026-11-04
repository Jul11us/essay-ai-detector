"""Provenance-aware local evaluation of the exact /api/detect pipeline.

No essay text or input file paths are written to prediction/report artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from app.calibration_fit import build_profile, validate_split_groups
from app.evaluation_stats import LABELS, LANGS, summarize
from app.evaluation_summary import render_summary


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


SAFE_PREDICTION_FIELDS = (
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


def _check_local_api(base_url: str) -> None:
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Benchmark API must be a local HTTP service")


def load_checkpoint(path: Path, rows: list[dict]) -> list[dict]:
    """Read predictions saved by an interrupted run.

    Only the last line may be cut off (a crash while writing it); it is dropped. Any other bad
    line, an id that is not in the manifest, or a duplicate id stops the run instead of
    silently mixing results from a different sample set.
    """
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    ids = {row["id"] for row in rows}
    saved: list[dict] = []
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            if number == len(lines):
                print(
                    f"Checkpoint: ignoring an incomplete last line ({path.name})", file=sys.stderr
                )
                break
            raise ValueError(f"Checkpoint line {number} is not valid JSON") from None
        if not isinstance(item, dict) or item.get("id") not in ids:
            raise ValueError(f"Checkpoint line {number} does not belong to this manifest")
        if any(prev["id"] == item["id"] for prev in saved):
            raise ValueError(f"Checkpoint has a duplicate id: {item['id']}")
        entry = {k: item.get(k) for k in SAFE_PREDICTION_FIELDS}
        entry["model_revision"] = entry["model_revision"] or "unknown"
        saved.append(entry)
    return saved


def wait_for_models(base_url: str, langs: set[str], timeout_s: float, poll_s: float = 2.0) -> None:
    """Poll /api/status until every language in the manifest has its model loaded."""
    import httpx

    _check_local_api(base_url)
    deadline = time.monotonic() + timeout_s
    with httpx.Client(
        base_url=base_url, timeout=10.0, follow_redirects=False, trust_env=False
    ) as client:
        while True:
            try:
                status = client.get("/api/status").json()
                models = status.get("models", {})
                missing = sorted(lang for lang in langs if not models.get(lang))
                if not missing:
                    return
                if not status.get("loading", True):
                    raise RuntimeError(
                        "Model not available for: "
                        + ", ".join(missing)
                        + " (loading finished without it; see the server log)"
                    )
            except (httpx.HTTPError, ValueError, AttributeError):
                missing = sorted(langs)
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"Models still not ready after {timeout_s:.0f}s: " + ", ".join(missing)
                )
            time.sleep(poll_s)


def _error_code(response) -> str:
    """Our API answers errors with a fixed code such as `too_short`. Show only that code, never
    any other response text, which could in principle carry essay content."""
    try:
        code = response.json().get("error")
    except (ValueError, AttributeError):
        return ""
    return f" ({code})" if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,40}", code) else ""


def fetch_inference(base_url: str) -> dict | None:
    """What the server says it scores with: runtime, library versions and weight fingerprints.

    Kept in the report as provenance; only these known keys are copied.
    """
    import httpx

    _check_local_api(base_url)
    try:
        with httpx.Client(
            base_url=base_url, timeout=10.0, follow_redirects=False, trust_env=False
        ) as client:
            status = client.get("/api/status").json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(status, dict):
        return None
    return {
        key: status[key]
        for key in ("runtime", "inference_stack", "model_revisions")
        if isinstance(status.get(key), dict)
    } or None


def run_api(rows: list[dict], base_url: str, checkpoint: Path | None = None) -> list[dict]:
    """Score every manifest row through the exact local /api/detect pipeline.

    With `checkpoint`, each prediction is appended to that file as soon as it is made, and rows
    already in it are skipped, so a long CPU run that stops (a crash, Ctrl-C, one sample the API
    rejects) keeps its progress and can be resumed. The model id and revision of new predictions
    must match the saved ones for the same language.
    """
    import httpx

    _check_local_api(base_url)
    saved = load_checkpoint(checkpoint, rows) if checkpoint else []
    done = {p["id"] for p in saved}
    models = {}
    by_id = {row["id"]: row for row in rows}
    for p in saved:
        models.setdefault(by_id[p["id"]]["lang"], (p["model_id"], p["model_revision"]))
    predictions: list[dict] = list(saved)
    todo = [row for row in rows if row["id"] not in done]
    if saved:
        print(f"Resuming: {len(saved)} saved, {len(todo)} to score", file=sys.stderr)
    out = None
    if checkpoint:
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        out = checkpoint.open("a", encoding="utf-8")
    try:
        with httpx.Client(
            base_url=base_url, timeout=660.0, follow_redirects=False, trust_env=False
        ) as client:
            for number, row in enumerate(todo, 1):
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
                    raise RuntimeError(
                        f"{row['id']}: API HTTP {response.status_code}{_error_code(response)}"
                    )
                try:
                    result = response.json()
                    prediction = {
                        "id": row["id"],
                        "score": result["score"],
                        "verdict": result["verdict"],
                        "model_id": result["model_id"],
                        # The API sends null when it cannot fingerprint the weights (e.g. sharded
                        # files). Record that as "unknown" so the report still builds and the
                        # calibration lists it as a reason it cannot be validated.
                        "model_revision": result.get("model_revision") or "unknown",
                        "char_count": result.get("char_count"),
                        "word_count": result.get("word_count"),
                        "confidence": result.get("confidence", "unknown"),
                        "latency_ms": elapsed_ms,
                        "api_pipeline": "/api/detect",
                    }
                except (ValueError, KeyError, TypeError):
                    raise RuntimeError(f"{row['id']}: invalid API response structure") from None
                model = (prediction["model_id"], prediction["model_revision"])
                if models.setdefault(row["lang"], model) != model:
                    raise RuntimeError(
                        f"{row['id']}: the {row['lang']} model differs from the one in the "
                        "checkpoint; start a new run with a new predictions file"
                    )
                predictions.append(prediction)
                if out is not None:
                    out.write(json.dumps(prediction, ensure_ascii=False, allow_nan=False) + "\n")
                    out.flush()
                if number % 10 == 0 or number == len(todo):
                    print(f"[{number}/{len(todo)}] scored", file=sys.stderr)
    finally:
        if out is not None:
            out.close()
    order = {row["id"]: i for i, row in enumerate(rows)}
    return sorted(predictions, key=lambda p: order[p["id"]])


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
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Continue an interrupted API run: keep the predictions already in --predictions-out",
    )
    parser.add_argument(
        "--wait-for-models",
        type=float,
        default=0,
        metavar="SECONDS",
        help="Before scoring, wait up to this long for the needed models to finish loading",
    )
    parser.add_argument(
        "--summary-out",
        type=Path,
        help="Write a readable Markdown summary (no essay text, no sample ids)",
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
    inference = None
    if args.predictions:
        predictions = load_predictions(args.predictions)
    else:
        checkpoint = args.predictions_out
        if checkpoint and checkpoint.exists() and checkpoint.stat().st_size and not args.resume:
            parser.error(
                f"{checkpoint} already has predictions; pass --resume to continue that run "
                "or choose a new --predictions-out"
            )
        try:
            if args.wait_for_models > 0:
                wait_for_models(args.api, {row["lang"] for row in rows}, args.wait_for_models)
            predictions = run_api(rows, args.api, checkpoint=checkpoint)
            inference = fetch_inference(args.api)
        except (RuntimeError, ValueError, KeyboardInterrupt) as error:
            saved = (
                sum(1 for line in checkpoint.read_text(encoding="utf-8").splitlines() if line)
                if checkpoint and checkpoint.exists()
                else 0
            )
            hint = (
                f"{saved} predictions are saved in {checkpoint}; fix the problem and rerun the "
                "same command with --resume to continue."
                if checkpoint
                else "Nothing was saved; pass --predictions-out to keep progress next time."
            )
            reason = "interrupted (Ctrl-C)" if isinstance(error, KeyboardInterrupt) else error
            sys.exit(f"Stopped: {reason}\n{hint}")
    report = summarize(rows, predictions, confidence_level=args.confidence_level)
    if inference:
        report["inference"] = inference
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
        safe_predictions = [{k: r[k] for k in SAFE_PREDICTION_FIELDS} for r in report["records"]]
        args.predictions_out.write_text(
            "".join(
                json.dumps(p, ensure_ascii=False, allow_nan=False) + "\n" for p in safe_predictions
            ),
            encoding="utf-8",
        )
    _save_json(args.out, report)
    if profile is not None:
        _save_json(args.calibration_out, profile)
    if args.summary_out:
        args.summary_out.parent.mkdir(parents=True, exist_ok=True)
        args.summary_out.write_text(render_summary(report, profile), encoding="utf-8")
        print(f"Saved summary: {args.summary_out}")
    print(f"Saved report: {report['overall']['n']} samples")
    if profile is not None:
        print(
            "Calibration: "
            + ", ".join(f"{lang}={p['status']}" for lang, p in profile["languages"].items())
        )


if __name__ == "__main__":
    main()
