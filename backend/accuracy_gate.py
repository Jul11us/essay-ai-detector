"""Counts-only regression gate for the fixed real-model CI evaluation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from app.model_artifacts import MODEL_COMMITS

TOLERANCE = 1
BASELINE = Path(__file__).parent / "tests" / "accuracy_baseline.json"


def snapshot(report: dict) -> dict:
    records = report.get("records", [])
    if not records:
        raise ValueError("Empty report")
    identities, seen, languages, models = [], set(), {}, {}
    for r in records:
        if r["id"] in seen:
            raise ValueError("Duplicate sample id")
        seen.add(r["id"])
        if r["lang"] not in {"en", "zh"} or r["label"] not in {"human", "ai"}:
            raise ValueError("Expected en/zh human/ai samples only")
        if r["verdict"] not in {"high", "low", "uncertain"}:
            raise ValueError("Invalid verdict")
        if not r.get("input_sha256") or not r.get("dataset_revision"):
            raise ValueError("Missing sample provenance")
        identity = {k: r[k] for k in ("id", "lang", "label", "input_sha256", "dataset_revision")}
        identities.append(identity)
        model = {k: r[k] for k in ("model_id", "model_revision")}
        if any(not v or v == "unknown" for v in model.values()):
            raise ValueError("Missing model revision")
        lang = r["lang"]
        if lang in models and models[lang] != model:
            raise ValueError("Mixed model revisions")
        models[lang] = model
        c = languages.setdefault(lang, dict(n=0, human=0, ai=0, false_flags=0, misses=0,
                                           human_uncertain=0, ai_uncertain=0, abstain=0))
        c["n"] += 1
        c[r["label"]] += 1
        c["false_flags"] += r["label"] == "human" and r["verdict"] == "high"
        c["misses"] += r["label"] == "ai" and r["verdict"] != "high"
        c["human_uncertain"] += r["label"] == "human" and r["verdict"] == "uncertain"
        c["ai_uncertain"] += r["label"] == "ai" and r["verdict"] == "uncertain"
        c["abstain"] += r.get("confidence") == "low"
    if set(languages) != {"en", "zh"} or any(not c["human"] or not c["ai"] for c in languages.values()):
        raise ValueError("Both languages and both labels are required")
    payload = json.dumps(sorted(identities, key=lambda r: r["id"]), sort_keys=True).encode()
    return {"schema_version": 1, "pinned_model_commits": dict(MODEL_COMMITS),
            "sample_fingerprint": hashlib.sha256(payload).hexdigest(),
            "models": models, "languages": languages}


def compare(current: dict, baseline: dict) -> tuple[list[str], list[str]]:
    for key in ("schema_version", "sample_fingerprint", "models", "pinned_model_commits"):
        if current[key] != baseline.get(key):
            raise ValueError(f"{key} mismatch; re-record baseline after reviewing the change")
    failures, improvements = [], []
    for lang, c in current["languages"].items():
        b = baseline["languages"][lang]
        if any(c[k] != b[k] for k in ("n", "human", "ai")):
            raise ValueError("Sample counts mismatch; re-record baseline")
        for metric in ("false_flags", "misses"):
            message = f"{lang} {metric}: {c[metric]} (baseline {b[metric]}, tolerance +{TOLERANCE})"
            if c[metric] > b[metric] + TOLERANCE:
                failures.append(message)
            elif c[metric] < b[metric]:
                improvements.append(message)
    return failures, improvements


def table(current: dict) -> str:
    lines = ["## Accuracy gate", "", "| Language | n (human/AI) | False flags | Misses (AI not high) | Uncertain human/AI | Abstain (low confidence) |",
             "| --- | --- | --- | --- | --- | --- |"]
    for lang, c in sorted(current["languages"].items()):
        lines.append(f"| {lang} | {c['n']} ({c['human']}/{c['ai']}) | {c['false_flags']} | {c['misses']} | {c['human_uncertain']}/{c['ai_uncertain']} | {c['abstain']} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()
    try:
        current = snapshot(json.loads(args.report.read_text(encoding="utf-8")))
        summary = table(current)
        if args.record:
            args.baseline.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            result = "Recorded accuracy baseline"
        else:
            failures, improvements = compare(current, json.loads(args.baseline.read_text(encoding="utf-8")))
            result = "FAIL: " + "; ".join(failures) if failures else "PASS: accuracy counts within baseline tolerance (+1 sample per metric/language)"
            if improvements:
                result += "\nImprovement: " + "; ".join(improvements) + "; consider re-recording baseline"
        print(summary + result)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
                stream.write(summary + "\n" + result + "\n")
        if not args.record and failures:
            raise SystemExit(1)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(1, f"Accuracy gate error: {exc}; re-record baseline if inputs intentionally changed\n")


if __name__ == "__main__":
    main()
