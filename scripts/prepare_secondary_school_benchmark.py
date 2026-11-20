"""Build pinned, prompt-isolated PERSUADE non-ELL grade 6-12 dev/test cohorts."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import unicodedata
import urllib.request
from collections import Counter, defaultdict, deque
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = REPO_ROOT / "experiments" / "benchmark-private"
REVISION = "5bdbad1175d1d5adec082b3f1c4e3ce37b7bd1bf"
SOURCE_URL = f"https://github.com/scrosseye/persuade_corpus_2.0/tree/{REVISION}"
FILES = {
    "README.md": {
        "url": f"https://raw.githubusercontent.com/scrosseye/persuade_corpus_2.0/{REVISION}/README.md",
        "sha256": "2f984c8712650050a71e3adc536dac6995721f6a44a64b05cb869881892e0108",
        "limit": 100_000,
    },
    "persuade_2.0_human_scores_demo_id_github_train.csv": {
        "url": "https://drive.usercontent.google.com/download?id=13phHyDzIsb0MHyJr6q-B-qIa9P2tM135&export=download&confirm=t",
        "sha256": "f61319edd8bf16a982711ea0399fad59c05afaec05cdf0767f16a2c05c467e23",
        "limit": 700_000_000,
    },
}
DATA_FILE = "persuade_2.0_human_scores_demo_id_github_train.csv"
SEED = 20261120


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def prompt_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch_file(out: Path, name: str) -> bytes:
    info = FILES[name]
    path = out / "raw" / name
    if path.exists():
        data = path.read_bytes()
    else:
        request = urllib.request.Request(info["url"], headers={"User-Agent": "essay-ai-detector-persuade-benchmark/1"})
        with urllib.request.urlopen(request, timeout=180) as response:
            data = response.read(info["limit"] + 1)
        if len(data) > info["limit"]:
            raise ValueError(f"Source download exceeds size limit: {name}")
    if digest(data) != info["sha256"]:
        raise ValueError(f"Source checksum mismatch: {name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def unique_essays(rows) -> list[dict]:
    unique = {}
    keys = ("full_text", "prompt_name", "grade_level", "ell_status", "assignment")
    for row in rows:
        ident = row["essay_id_comp"]
        if not ident or not row["prompt_name"].strip():
            raise ValueError("Missing essay ID or prompt")
        if ident in unique and any(unique[ident][k] != row[k] for k in keys):
            raise ValueError(f"Inconsistent discourse rows for essay {ident}")
        unique.setdefault(ident, {k: row[k] for k in ("essay_id_comp",) + keys})
    return list(unique.values())


def select(rows, dev_prompts: set[str], excluded: set[str], per_split: int = 200,
           seed: int = SEED) -> list[dict]:
    if per_split <= 0:
        raise ValueError("per_split must be positive")
    pools = defaultdict(list)
    for row in unique_essays(rows):
        text = row["full_text"]
        if row["ell_status"].strip() != "No" or row["grade_level"].strip() not in {str(i) for i in range(6, 13)}:
            continue
        compact = re.sub(r"\s", "", text)
        latin = len(re.findall(r"[A-Za-z]", text))
        cjk = len(re.findall(r"[\u3400-\u9fff]", text))
        if not 400 <= len(compact) <= 8000 or latin < 200 or cjk / max(1, cjk + latin) >= .15:
            continue
        pools[prompt_key(row["prompt_name"])].append(row)
    used = set(excluded)
    chosen = []
    for split in ("dev", "test"):
        prompts = sorted((p for p in pools if (p in dev_prompts) == (split == "dev")),
                         key=lambda p: digest(f"{seed}:prompt:{p}"))
        queues = {p: deque(sorted(pools[p], key=lambda r: digest(f"{seed}:essay:{r['essay_id_comp']}"))) for p in prompts}
        count = 0
        while count < per_split:
            progress = False
            for p in prompts:
                while queues[p]:
                    row = queues[p].popleft()
                    sha = digest(normalized(row["full_text"]))
                    if sha in used:
                        continue
                    used.add(sha)
                    chosen.append(dict(row, split=split, prompt_key=p))
                    count += 1
                    progress = True
                    break
                if count == per_split:
                    break
            if not progress:
                raise ValueError(f"Not enough distinct eligible essays for {split}: {count}/{per_split}")
    return chosen


def write_corpus(out: Path, rows: list[dict], seed: int, reference_sha256: str) -> dict:
    (out / "samples").mkdir(parents=True, exist_ok=True)
    records = []
    for row in rows:
        ident = f"persuade-en-{row['essay_id_comp']}-human"
        filename = f"samples/{ident}.txt"
        (out / filename).write_bytes(row["full_text"].encode("utf-8"))
        records.append({
            "id": ident, "file": filename, "lang": "en", "domain": "composition", "genre": "composition",
            "label": "human", "split": row["split"], "group_id": "ellipse-prompt-" + row["prompt_key"],
            "source": "PERSUADE 2.0", "source_url": SOURCE_URL, "dataset_revision": REVISION,
            "source_file": DATA_FILE, "source_sha256": FILES[DATA_FILE]["sha256"],
            "source_row_id": row["essay_id_comp"], "license": "CC-BY-4.0", "training_overlap": "unknown",
            "text_sha256": digest(row["full_text"]), "normalized_text_sha256": digest(normalized(row["full_text"])),
            "grade_level": int(row["grade_level"]), "ell_status": "No", "generated_model": None,
            "writer_group": "us_non_ell_secondary_grade6_12", "native_language": "not recorded; non-ELL proxy only",
            "prompt_name": row["prompt_name"],
        })
    records.sort(key=lambda r: r["id"])
    manifest = out / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in records), encoding="utf-8")
    summary = {
        "seed": seed, "dataset_revision": REVISION, "source_url": SOURCE_URL,
        "source_files": FILES, "reference_rows_sha256": reference_sha256,
        "manifest_sha256": digest(manifest.read_bytes()),
        "counts": dict(Counter(f"{r['split']}:human" for r in records)),
        "prompts": {s: sorted({r["prompt_name"] for r in records if r["split"] == s}) for s in ("dev", "test")},
        "grades": dict(Counter(str(r["grade_level"]) for r in records)),
        "selection": "Explicit ell_status No, known grade 6-12, length/language only; deduplicate discourse rows and normalized text; round-robin seeded essay order across prompts; dev restricted to learner-dev prompts, all other prompts test.",
        "limits": ["Non-ELL is recorded, not proof of native first language.", "No detector-training independence or cross-prompt student-identity independence established.", "Official Drive data pinned by SHA-256; changed content aborts preparation.", "Shared ELLIPSE/PERSUADE prompts use the same group ID for cross-source isolation."],
    }
    (out / "preparation.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=PRIVATE_ROOT / "persuade")
    parser.add_argument("--reference-manifest", type=Path, default=PRIVATE_ROOT / "student-rules" / "manifest.jsonl")
    parser.add_argument("--per-split", type=int, default=200)
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(PRIVATE_ROOT.resolve()):
        parser.error("--out must be inside experiments/benchmark-private")
    reference = [r for r in map(json.loads, args.reference_manifest.read_text().splitlines()) if r["source"] != "PERSUADE 2.0"]
    dev_prompts = {r["group_id"].removeprefix("ellipse-prompt-") for r in reference
                   if r["split"] == "dev" and r["group_id"].startswith("ellipse-prompt-")}
    excluded = set()
    for row in reference:
        path = (PRIVATE_ROOT / row["file"]).resolve()
        if not path.is_relative_to(PRIVATE_ROOT.resolve()):
            parser.error("Reference files must be inside experiments/benchmark-private")
        excluded.add(digest(normalized(path.read_text())))
    fetch_file(out, "README.md")
    fetch_file(out, DATA_FILE)
    with (out / "raw" / DATA_FILE).open(encoding="utf-8-sig", newline="") as source:
        rows = select(csv.DictReader(source), dev_prompts, excluded, args.per_split, args.seed)
    summary = write_corpus(out, rows, args.seed, digest(json.dumps(reference, sort_keys=True)))
    print(json.dumps({"manifest": str(out / "manifest.jsonl"), **summary}))


if __name__ == "__main__":
    main()
