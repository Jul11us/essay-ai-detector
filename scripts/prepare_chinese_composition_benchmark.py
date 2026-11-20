"""Build pinned C-ReD composition dev/test pairs; keep text in gitignored storage."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = REPO_ROOT / "experiments" / "benchmark-private"
REVISION = "b90072cd218b6ebdbd1d1478ce6e439677f18192"
SOURCE_URL = f"https://github.com/HeraldofLight/C-ReD/tree/{REVISION}"
RAW_URL = f"https://raw.githubusercontent.com/HeraldofLight/C-ReD/{REVISION}/benchmark%20data/composition"
MODELS = ("deepseek-v3", "gpt-4o", "qwen-3")
SHA256 = {
    "human": "7a22c744dac5bdd3ff4391e71f0351c384f24f7030b554dac48dfb8a185b394e",
    "deepseek-v3": "7f4bc0f34c1c6d42cd0ba9e5b626d95f4a1ba1eb8a57cd24e028feae78e5d08f",
    "gpt-4o": "0a884e3c1aac117b2034cb55b29246bc024f68d2d62eecfd23bfeb2b39975e73",
    "qwen-3": "d554af0ae846e1bf7196dd7251c6ae6cc6ff8921dec3751185612c7f05eca7e3",
}
SEED = 20261120


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())


def eligible(text: object) -> bool:
    if not isinstance(text, str):
        return False
    compact = re.sub(r"\s", "", text)
    return 400 <= len(compact) <= 8000 and len(re.findall(r"[\u3400-\u9fff]", compact)) >= len(compact) * 0.5


def fetch_file(out: Path, model: str) -> bytes:
    name = f"CReD_composition_{model}.csv"
    path = out / "raw" / name
    if path.exists():
        data = path.read_bytes()
    else:
        request = urllib.request.Request(f"{RAW_URL}/{name}", headers={"User-Agent": "essay-ai-detector-cred-benchmark/1"})
        with urllib.request.urlopen(request, timeout=90) as response:
            expected = response.headers.get("Content-Length")
            data = response.read(30_000_001)
        if len(data) > 30_000_000 or (expected is not None and len(data) != int(expected)):
            raise ValueError(f"Invalid download size: {model}")
    if digest(data) != SHA256[model]:
        raise ValueError(f"Source checksum mismatch: {model}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def select(tables: dict[str, list[dict]], pairs_per_split: int = 240, seed: int = SEED) -> list[dict]:
    if pairs_per_split <= 0 or pairs_per_split % len(MODELS):
        raise ValueError("pairs_per_split must be positive and divisible by three")
    humans = {r["id"]: r for r in tables["human"]}
    titles: dict[str, list[dict]] = defaultdict(list)
    for model in MODELS:
        for ai in tables[model]:
            human = humans.get(ai["original_id"])
            if human is None or normalized(human["composition_title"]) != normalized(ai["composition_title"]):
                continue
            if human["label"] != "1" or ai["label"] != "0":
                raise ValueError("Unexpected source labels")
            if not eligible(human["text"]) or not eligible(ai["text"]):
                continue
            title = normalized(human["composition_title"])
            if title:
                titles[title].append({"human": human, "ai": ai, "model": model, "title": title})
    used_hashes: set[str] = set()
    used_titles: set[str] = set()
    chosen = []
    order = sorted(titles, key=lambda t: digest(f"{seed}:title:{t}"))
    for split in ("dev", "test"):
        counts: Counter = Counter()
        for title in order:
            if title in used_titles:
                continue
            wanted = min(MODELS, key=lambda model: (counts[model], MODELS.index(model)))
            pool = sorted((p for p in titles[title] if p["model"] == wanted),
                          key=lambda p: digest(f"{seed}:pair:{p['human']['id']}:{p['ai']['id']}"))
            for pair in pool:
                hashes = {digest(normalized(pair[label]["text"])) for label in ("human", "ai")}
                if len(hashes) != 2 or hashes & used_hashes:
                    continue
                chosen.append(dict(pair, split=split))
                used_titles.add(title)
                used_hashes.update(hashes)
                counts[wanted] += 1
                break
            if sum(counts.values()) == pairs_per_split:
                break
        if sum(counts.values()) != pairs_per_split:
            raise ValueError(f"Not enough distinct eligible title pairs for {split}: {sum(counts.values())}/{pairs_per_split}")
    return chosen


def write_corpus(out: Path, pairs: list[dict], seed: int) -> dict:
    (out / "samples").mkdir(parents=True, exist_ok=True)
    records = []
    for pair in pairs:
        for label in ("human", "ai"):
            row = pair[label]
            item_id = f"cred-zh-composition-{pair['human']['id']}-{label}"
            filename = f"samples/{item_id}.txt"
            (out / filename).write_bytes(row["text"].encode("utf-8"))
            records.append({
                "id": item_id, "file": filename, "lang": "zh", "domain": "composition", "genre": "composition",
                "label": label, "split": pair["split"], "group_id": f"cred-title-{digest(pair['title'])[:24]}",
                "source": "C-ReD composition", "source_url": SOURCE_URL, "dataset_revision": REVISION,
                "source_row_id": row["id"], "original_id": pair["human"]["id"],
                "source_file": f"CReD_composition_{'human' if label == 'human' else pair['model']}.csv",
                "license": "no license file at pinned revision; local evaluation only, do not redistribute",
                "training_overlap": "unknown", "text_sha256": digest(row["text"]),
                "normalized_text_sha256": digest(normalized(row["text"])),
                "generated_model": pair["model"] if label == "ai" else None,
                "writer_group": "cred_composition_human_authors_unspecified" if label == "human" else f"cred_{pair['model']}",
            })
    records.sort(key=lambda r: r["id"])
    manifest = out / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in records), encoding="utf-8")
    summary = {
        "seed": seed, "dataset_revision": REVISION, "source_sha256": SHA256,
        "manifest_sha256": digest(manifest.read_bytes()),
        "counts": dict(Counter(f"{r['split']}:{r['label']}:{r['generated_model']}" for r in records)),
        "selection": "Seeded title hash order, one original human/AI pair per title, balanced generators within each split; length/language only, no model scores.",
        "limits": ["No license file found at the pinned source revision; local evaluation only.",
                   "Training overlap unknown; dev/test title isolation does not establish detector training independence.",
                   "These are new cohorts, not an exact recreation of PR #4's uncommitted selection.",
                   "Split dev denotes rule development, not benchmark.py threshold calibration."],
    }
    (out / "preparation.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=PRIVATE_ROOT / "cred-composition")
    parser.add_argument("--pairs-per-split", type=int, default=240)
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(PRIVATE_ROOT.resolve()):
        parser.error("--out must be inside experiments/benchmark-private")
    tables = {model: list(csv.DictReader(io.StringIO(fetch_file(out, model).decode("utf-8-sig")))) for model in SHA256}
    summary = write_corpus(out, select(tables, args.pairs_per_split, args.seed), args.seed)
    print(json.dumps({"manifest": str(out / "manifest.jsonl"), **summary}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f"Corpus preparation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
