"""Local, provenance-aware evaluation of the exact /api/detect pipeline.

The manifest and report stay on this machine. No essay text is written to the report.
Run the API first, then: python benchmark.py corpus/manifest.jsonl --out corpus/report.json
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

LABELS = {"human", "ai", "mixed"}
LANGS = {"en", "zh"}
VERDICTS = {"low", "uncertain", "high"}


def load_manifest(path: Path) -> list[dict]:
    root = path.resolve().parent
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    seen: set[str] = set()
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
        item = (root / row["file"]).resolve()
        if not item.is_relative_to(root) or not item.is_file():
            raise ValueError(f"File must exist under the manifest directory: {row['id']}")
        if item.suffix.lower() not in {".txt", ".docx", ".pdf"}:
            raise ValueError(f"Unsupported file type: {row['id']}")
        row["_path"] = item
    if not rows:
        raise ValueError("Manifest is empty")
    return rows


def run_api(rows: list[dict], base_url: str) -> list[dict]:
    parsed = urlsplit(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise ValueError("Benchmark API must be a local HTTP service")
    predictions: list[dict] = []
    with httpx.Client(base_url=base_url, timeout=660.0) as client:
        for row in rows:
            path = row["_path"]
            with path.open("rb") as stream:
                response = client.post(
                    "/api/detect",
                    data={"lang": row["lang"]},
                    files={"file": (path.name, stream)},
                )
            if response.status_code != 200:
                raise RuntimeError(f"{row['id']}: API {response.status_code}: {response.text[:300]}")
            result = response.json()
            predictions.append({
                "id": row["id"],
                "score": result["score"],
                "verdict": result["verdict"],
                "model_id": result["model_id"],
            })
    return predictions


def load_predictions(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarize(rows: list[dict], predictions: list[dict]) -> dict:
    by_id = {p["id"]: p for p in predictions}
    if len(by_id) != len(predictions) or set(by_id) != {r["id"] for r in rows}:
        raise ValueError("Predictions must contain exactly one record for every manifest id")
    records = []
    for row in rows:
        p = by_id[row["id"]]
        if p.get("verdict") not in VERDICTS or not isinstance(p.get("score"), (int, float)):
            raise ValueError(f"Invalid prediction: {row['id']}")
        if not 0 <= p["score"] <= 1:
            raise ValueError(f"Score outside 0..1: {row['id']}")
        records.append({
            "id": row["id"],
            "lang": row["lang"],
            "label": row["label"],
            "source": row["source"],
            "writer_group": row.get("writer_group", "unspecified"),
            "score": p["score"],
            "verdict": p["verdict"],
            "model_id": p.get("model_id", "unknown"),
        })

    def counts(items: list[dict]) -> dict:
        labels = Counter(r["label"] for r in items)
        observed = {label: dict(Counter(r["verdict"] for r in items if r["label"] == label)) for label in LABELS}
        human = labels["human"]
        ai = labels["ai"]
        return {
            "n": len(items),
            "labels": dict(labels),
            "verdicts_by_label": observed,
            "human_high_false_flag": {"count": observed["human"].get("high", 0), "of": human},
            "ai_low_miss": {"count": observed["ai"].get("low", 0), "of": ai},
            "human_uncertain": {"count": observed["human"].get("uncertain", 0), "of": human},
            "ai_uncertain": {"count": observed["ai"].get("uncertain", 0), "of": ai},
            "mixed": observed["mixed"],
        }

    groups: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        groups[f"lang:{record['lang']}"].append(record)
        groups[f"writer_group:{record['writer_group']}"].append(record)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Descriptive local sample counts; mixed writing has no binary ground truth.",
        "overall": counts(records),
        "groups": {key: counts(items) for key, items in sorted(groups.items())},
        "records": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--predictions", type=Path, help="JSONL predictions; otherwise call the local API")
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    rows = load_manifest(args.manifest)
    predictions = load_predictions(args.predictions) if args.predictions else run_api(rows, args.api)
    report = summarize(rows, predictions)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {args.out}: {report['overall']['n']} samples")


if __name__ == "__main__":
    main()
