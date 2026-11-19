"""Prepare pinned C-ReD samples for the Chinese CI regression gate.

Complete source texts stay git-ignored. Selection uses coverage and seeded IDs,
never model scores. No dataset license was found at the pinned revision.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.errors import DetectError
from app.length import count_chars
from app.paragraphs import prepare_scoring_text, split_paragraphs

PRIVATE_ROOT = REPO_ROOT / "experiments" / "benchmark-private"
DEFAULT_OUT = PRIVATE_ROOT / "accuracy-cred"
DEFAULT_EXCLUSIONS = Path(__file__).with_name("paper-composition-pr4-ci-exclusions.csv")
REVISION = "b90072cd218b6ebdbd1d1478ce6e439677f18192"
SEED = "zh-ci-investigation-v1"
DOMAINS = ("composition", "paper")
GENERATORS = ("deepseek-v3", "gpt-4o", "qwen-3")
LICENSE_NOTE = "No dataset license found at the pinned revision; do not redistribute sample texts"
SHA256 = {
    ("composition", "human"): "7a22c744dac5bdd3ff4391e71f0351c384f24f7030b554dac48dfb8a185b394e",
    ("composition", "deepseek-v3"): "7f4bc0f34c1c6d42cd0ba9e5b626d95f4a1ba1eb8a57cd24e028feae78e5d08f",
    ("composition", "gpt-4o"): "0a884e3c1aac117b2034cb55b29246bc024f68d2d62eecfd23bfeb2b39975e73",
    ("composition", "qwen-3"): "d554af0ae846e1bf7196dd7251c6ae6cc6ff8921dec3751185612c7f05eca7e3",
    ("paper", "human"): "55e347b6d9e1e6df9dadaaf0c5c121052159da23b0d79c708fbdf2683b9d2918",
    ("paper", "deepseek-v3"): "3803f676cf28ea718347fb55de13bbbf570225384b40bf50e7cb326e7dd3f89d",
    ("paper", "gpt-4o"): "7e32e1c3c2f2ea8a2d83fcbe4952d2b72a4d2b7bd6dc9b24e65e64196679363e",
    ("paper", "qwen-3"): "0a76d3e6ba56999338a09ae1ccb346021b0e1553620bdfdd1ce237596e01d0e4",
}


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def filename(domain: str, generator: str) -> str:
    return f"CReD_{domain}_{generator}.csv"


def source_url(domain: str, generator: str) -> str:
    return f"https://raw.githubusercontent.com/HeraldofLight/C-ReD/{REVISION}/benchmark%20data/{domain}/{filename(domain, generator)}"


def fetch_source(out: Path, domain: str, generator: str) -> Path:
    path = out / "raw" / filename(domain, generator)
    expected = SHA256[domain, generator]
    if path.exists():
        if digest(path.read_bytes()) != expected:
            raise ValueError(f"Cached source checksum mismatch: {domain}/{generator}; remove that raw file and retry")
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".csv.part")
    try:
        with urllib.request.urlopen(source_url(domain, generator), timeout=90) as response, partial.open("wb") as stream:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 10_000_000:
                    raise ValueError("Source exceeds the expected download size")
                stream.write(chunk)
        if digest(partial.read_bytes()) != expected:
            raise ValueError(f"Downloaded source checksum mismatch: {domain}/{generator}")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)
    return path


def load_exclusions(path: Path) -> dict[str, set]:
    result = {"groups": set(), "hashes": set(), "ids": set()}
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                if row.get("genre") not in DOMAINS or not row.get("original_id") or not row.get("input_sha256"):
                    raise ValueError("Exclusion CSV requires genre, original_id and input_sha256")
                if row.get("dataset_revision") != REVISION:
                    raise ValueError("Exclusion CSV revision mismatch")
                result["groups"].add((row["genre"], row["original_id"]))
                result["hashes"].add(row["input_sha256"])
    else:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list) or not all(isinstance(value, str) and value.strip() for value in data):
            raise ValueError("Exclusions must be a JSON array of C-ReD sample ids or text SHA-256 strings")
        result["ids"].update(data)
        result["hashes"].update(data)
    return result


def exclude(pools: dict[tuple[str, str], list[dict]], exclusions: dict[str, set]) -> dict[tuple[str, str], list[dict]]:
    def excluded(row: dict) -> bool:
        return ((row["domain"], row["original_id"]) in exclusions["groups"]
                or row["text_sha256"] in exclusions["hashes"] or row["id"] in exclusions["ids"])

    return {key: [r for r in rows if not excluded(r)]
            for key, rows in pools.items()}


def pool_sizes(pools: dict[tuple[str, str], list[dict]]) -> dict[str, int]:
    return {f"{domain}:{label}": len({r["title_sha256"] for (d, g), rows in pools.items()
                                    if d == domain and (g == "human") == (label == "human")
                                    for r in rows if r["coverage_qualified"]})
            for domain in DOMAINS for label in ("human", "ai")}


def candidates(rows: list[dict], domain: str, generator: str) -> list[dict]:
    result = []
    for row in rows:
        text = row.get("text")
        title = row.get(f"{domain}_title")
        source_id = row.get("id")
        if not isinstance(text, str) or not isinstance(title, str) or not title.strip() or not source_id:
            continue
        scored, _, _ = prepare_scoring_text(text)
        try:
            parts = split_paragraphs(scored, "zh")
        except DetectError:
            continue
        chars = count_chars("".join(parts))
        if not 200 <= chars <= 10000:
            continue
        result.append({
            "id": f"cred-{domain}-{generator}-{source_id}", "source_id": source_id,
            "original_id": row.get("original_id", source_id), "text": text,
            "domain": domain, "generator": generator,
            "label": "human" if generator == "human" else "ai",
            "text_sha256": digest(text), "title_sha256": digest(" ".join(title.split())),
            "scored_chars": chars, "scored_parts": len(parts),
            "coverage_qualified": chars >= 400 and len(parts) >= 2,
        })
    return sorted(result, key=lambda r: (not r["coverage_qualified"], digest(f"{SEED}:{r['id']}")))


def select(pools: dict[tuple[str, str], list[dict]], per_label: int) -> list[dict]:
    if per_label < 3:
        raise ValueError("--per-label must be at least 3")
    sizes = pool_sizes(pools)
    if min(sizes.values()) < 3:
        raise ValueError("Insufficient eligible samples in an evaluation cell")
    selected, seen_hashes = [], set()
    for domain in DOMAINS:
        seen_ai_titles: set[str] = set()
        for index, generator in enumerate(("human", *GENERATORS)):
            total = min(per_label, sizes[f"{domain}:{'human' if generator == 'human' else 'ai'}"])
            target = total if generator == "human" else total // 3 + (index <= total % 3)
            titles = set() if generator == "human" else seen_ai_titles
            added = 0
            for row in pools[domain, generator]:
                if (not row["coverage_qualified"] or row["text_sha256"] in seen_hashes
                        or row["title_sha256"] in titles):
                    continue
                selected.append(row)
                titles.add(row["title_sha256"])
                seen_hashes.add(row["text_sha256"])
                added += 1
                if added == target:
                    break
            if added != target:
                raise ValueError(f"Insufficient eligible samples: {domain}/{generator} ({added}/{target})")
    return selected


def write_corpus(out: Path, selected: list[dict]) -> dict:
    (out / "samples").mkdir(parents=True, exist_ok=True)
    records = []
    for row in selected:
        domain, generator = row["domain"], row["generator"]
        name = f"samples/{row['id']}.txt"
        (out / name).write_bytes(row["text"].encode("utf-8"))
        record = {key: row[key] for key in ("id", "domain", "label", "source_id", "original_id", "text_sha256",
                                          "title_sha256", "scored_chars", "scored_parts", "coverage_qualified")}
        record.update(file=name, lang="zh", source="C-ReD", source_url=source_url(domain, generator),
                      dataset_revision=REVISION, source_sha256=SHA256[domain, generator],
                      license=LICENSE_NOTE, training_overlap="unknown",
                      group_id=f"cred-{domain}-{row['title_sha256']}", split="test",
                      writer_group="public_authors_unspecified" if generator == "human" else generator,
                      generated_model=None if generator == "human" else generator,
                      text_transformation="none; exact complete CSV text field")
        records.append(record)
    manifest = out / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records), encoding="utf-8")
    summary = {
        "dataset_revision": REVISION, "seed": SEED, "license": LICENSE_NOTE,
        "selection": "coverage qualified only (>=400 scored chars and >=2 scoring segments), then SHA256 seeded id order; no model scores; complete texts; up to 40/label",
        "fitting_overlap": "PR #4 original-id groups and text hashes excluded before selection",
        "counts": dict(sorted(Counter(f"{r['domain']}:{r['label']}" for r in records).items())),
        "coverage_counts": dict(sorted(Counter(f"{r['domain']}:{r['label']}:{r['coverage_qualified']}" for r in records).items())),
        "manifest_sha256": digest(manifest.read_bytes()),
    }
    (out / "preparation.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--per-label", type=int, default=40)
    parser.add_argument("--exclude", type=Path, help="Additional CSV exclusions or JSON array of sample ids/text SHA-256s; PR #4 exclusions always apply")
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(PRIVATE_ROOT.resolve()):
        parser.error("--out must be inside experiments/benchmark-private (git-ignored)")
    if args.per_label < 20:
        parser.error("--per-label must be at least 20 for the CI gate")
    exclusions = load_exclusions(DEFAULT_EXCLUSIONS)
    if args.exclude:
        additional = load_exclusions(args.exclude)
        for key in exclusions:
            exclusions[key].update(additional[key])
    pools = {}
    for domain, generator in SHA256:
        path = fetch_source(out, domain, generator)
        with path.open(encoding="utf-8-sig", newline="") as stream:
            pools[domain, generator] = candidates(list(csv.DictReader(stream)), domain, generator)
    pools = exclude(pools, exclusions)
    sizes = pool_sizes(pools)
    if min(sizes.values()) < 20:
        raise ValueError(f"Fewer than 20 coverage-qualified samples remain in a cell: {json.dumps(sizes, sort_keys=True)}")
    selected = select(pools, args.per_label)
    selected_counts = Counter(f"{r['domain']}:{r['label']}" for r in selected)
    if min(selected_counts.values()) < 20:
        raise ValueError(f"Fewer than 20 selected samples in a cell: {dict(selected_counts)}")
    if any((r["domain"], r["original_id"]) in exclusions["groups"] or r["text_sha256"] in exclusions["hashes"] for r in selected):
        raise ValueError("Selected samples overlap exclusions")
    summary = write_corpus(out, selected)
    summary.update(remaining_pool_sizes=sizes, exclusion_original_id_overlap=0, exclusion_hash_overlap=0,
                   default_exclusions_sha256=digest(DEFAULT_EXCLUSIONS.read_bytes()))
    (out / "preparation.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f"C-ReD preparation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
