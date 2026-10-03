"""Prepare a reproducible, local HC3 Q&A pilot; never read personal documents.

Downloads only official, pinned HC3 source files. Full answers remain in the
git-ignored benchmark directory; stdout contains counts and checksums only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "experiments" / "benchmark-private" / "public-hc3"
COPYRIGHT_URL = "https://github.com/Hello-SimpleAI/chatgpt-comparison-detection#dataset-copyright"
PAPER_URL = "https://arxiv.org/abs/2301.07597"
DATASETS = {
    "en": {"repo": "Hello-SimpleAI/HC3", "revision": "4d0ff18143b5a7e1b1e79beb540c04549d1e59d3"},
    "zh": {"repo": "Hello-SimpleAI/HC3-Chinese", "revision": "09a687b8dc164b89e7df95abf15df3b216bc31c2"},
}
# Source licenses are reported by HC3's authors. The corpus card's CC-BY-SA-4.0
# terms apply, and stricter source terms continue to apply. Unknown-license
# domains and noncommercial medicine are intentionally not part of this pilot.
SOURCES = {
    ("en", "reddit_eli5"): {
        "sha256": "448cebaf7fdf27560daf6cc87cc1464be4988cf8110c0ec40c40b21c2c0193db",
        "source_license": "BSD (as reported by HC3)",
        "original_source_url": "https://github.com/facebookresearch/ELI5",
    },
    ("en", "wiki_csai"): {
        "sha256": "4f78105c72e7edd3b619b3b44abac1e6f8bdb42211f22e43191d4dae889e1968",
        "source_license": "CC-BY-SA (as reported by HC3)",
        "original_source_url": "https://en.wikipedia.org/wiki/Wikipedia:FAQ/Copyright",
    },
    ("zh", "open_qa"): {
        "sha256": "ccac1bec153b57646ace3dbd4fdb677e7d66a789127119ffeab9ac56aa01df83",
        "source_license": "MIT (as reported by HC3)",
        "original_source_url": "https://github.com/brightmart/nlp_chinese_corpus",
    },
    ("zh", "finance"): {
        "sha256": "91251b749d645543f834012384554c753c2950db475e052508a469688fe82699",
        "source_license": "CC-BY-4.0 (as reported by HC3)",
        "original_source_url": "https://www.heywhale.com/mw/dataset/5e9588f8e7ec38002d0331b1/content",
    },
    ("zh", "psychology"): {
        "sha256": "c8cd18b06c419f04ea1a7116896f2066c2fc9d9bf4ef6f9fe73f490498200963",
        "source_license": "CC0 (as reported by HC3)",
        "original_source_url": "https://aistudio.baidu.com/aistudio/datasetdetail/38489",
    },
}
LENGTHS = {"en": (400, 2500), "zh": (200, 2500)}
_WHITESPACE = re.compile(r"\s+")
_CJK = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\U00020000-\U0002a6df]")
_LATIN = re.compile(r"[A-Za-z]")


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def char_count(text: str) -> int:
    return len(_WHITESPACE.sub("", text))


def eligible_answer(text: object, lang: str) -> bool:
    """Use length/language rules only; no model scores or style filtering."""
    if not isinstance(text, str):
        return False
    minimum, maximum = LENGTHS[lang]
    if not minimum <= char_count(text) <= maximum:
        return False
    cjk, latin = len(_CJK.findall(text)), len(_LATIN.findall(text))
    # Verify that the length contains enough characters of the requested language.
    if lang == "en":
        return latin >= 200 and cjk / max(1, cjk + latin) < 0.15
    return cjk >= 150 and cjk / max(1, cjk + latin) >= 0.50


def source_url(lang: str, domain: str) -> str:
    info = DATASETS[lang]
    return f"https://huggingface.co/datasets/{info['repo']}/resolve/{info['revision']}/{domain}.jsonl"


def fetch_source(out: Path, lang: str, domain: str) -> Path:
    path = out / "raw" / f"{lang}-{domain}.jsonl"
    expected = SOURCES[lang, domain]["sha256"]
    if path.exists():
        if digest(path.read_bytes()) != expected:
            raise ValueError(f"Cached source checksum mismatch: {lang}/{domain}; remove that raw file and retry")
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".jsonl.part")
    request = urllib.request.Request(source_url(lang, domain), headers={"User-Agent": "essay-ai-detector-hc3-pilot/1"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response, partial.open("wb") as stream:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 100_000_000:
                    raise ValueError("Source exceeds the expected download size")
                stream.write(chunk)
        if digest(partial.read_bytes()) != expected:
            raise ValueError(f"Downloaded source checksum mismatch: {lang}/{domain}")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)
    return path


def candidates(rows: list[dict], lang: str, domain: str, seed: int) -> list[dict]:
    result = []
    for index, row in enumerate(rows):
        question = row.get("question")
        if not isinstance(question, str) or not question.strip():
            continue
        answers = []
        for field in ("human_answers", "chatgpt_answers"):
            options = row.get(field)
            if not isinstance(options, list):
                options = []
            choice = next(((i, value) for i, value in enumerate(options) if eligible_answer(value, lang)), None)
            if choice is None:
                break
            answers.append(choice)
        if len(answers) != 2:
            continue
        human, ai = answers
        if human[1] == ai[1]:
            continue
        question_sha = digest(" ".join(question.split()))
        group_id = f"hc3-{lang}-{question_sha}"
        result.append({
            "lang": lang, "domain": domain, "source_row": index,
            "question_sha256": question_sha, "group_id": group_id,
            "human": human[1], "ai": ai[1],
            "human_answer_index": human[0], "ai_answer_index": ai[0],
            "_order": digest(f"{seed}:sample:{lang}:{domain}:{index}:{question_sha}"),
        })
    return sorted(result, key=lambda item: item["_order"])


def choose_pairs(pools: dict[tuple[str, str], list[dict]], pairs_per_language: int, seed: int) -> list[dict]:
    if pairs_per_language < 2 or pairs_per_language % 2:
        raise ValueError("pairs_per_language must be an even number of at least 2")
    chosen: list[dict] = []
    seen_groups: set[str] = set()
    seen_text: set[str] = set()
    for lang in DATASETS:
        domains = sorted(domain for candidate_lang, domain in pools if candidate_lang == lang)
        if not domains:
            continue
        positions = {domain: 0 for domain in domains}
        language_pairs: list[dict] = []
        while len(language_pairs) < pairs_per_language:
            progress = False
            for domain in domains:
                pool = pools[lang, domain]
                while positions[domain] < len(pool):
                    pair = pool[positions[domain]]
                    positions[domain] += 1
                    # Whitespace variants of an answer must not cross splits.
                    hashes = {digest(" ".join(pair[label].split())) for label in ("human", "ai")}
                    if len(hashes) != 2:
                        continue
                    if pair["group_id"] in seen_groups or hashes & seen_text:
                        continue
                    seen_groups.add(pair["group_id"])
                    seen_text.update(hashes)
                    language_pairs.append(dict(pair))
                    progress = True
                    break
                if len(language_pairs) >= pairs_per_language:
                    break
            if not progress:
                raise ValueError(f"Not enough distinct eligible full-answer pairs for {lang}: {len(language_pairs)}")
        # Assign within domain; the offset handles odd domain counts and ensures
        # half the total pairs are in each split without question/text leakage.
        offset = 0
        for domain in domains:
            domain_pairs = sorted(
                (p for p in language_pairs if p["domain"] == domain),
                key=lambda p: digest(f"{seed}:split:{p['group_id']}"),
            )
            for index, pair in enumerate(domain_pairs):
                pair["split"] = "calibration" if (offset + index) % 2 == 0 else "test"
            offset += len(domain_pairs)
        chosen.extend(language_pairs)
    return chosen


def write_corpus(out: Path, pairs: list[dict], *, mixed_per_language: int, seed: int) -> dict:
    if mixed_per_language < 0:
        raise ValueError("mixed_per_language cannot be negative")
    samples = out / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    records = []
    all_hashes: set[str] = set()
    by_lang: dict[str, list[dict]] = defaultdict(list)
    for pair in pairs:
        by_lang[pair["lang"]].append(pair)
        for label in ("human", "ai"):
            lang, domain = pair["lang"], pair["domain"]
            info, source = DATASETS[lang], SOURCES[lang, domain]
            item_id = f"hc3-{lang}-{domain}-{pair['source_row']:05d}-{label}"
            text = pair[label]
            filename = f"samples/{item_id}.txt"
            (out / filename).write_bytes(text.encode("utf-8"))
            text_sha = digest(text)
            all_hashes.add(text_sha)
            records.append({
                "id": item_id, "file": filename, "lang": lang, "label": label,
                "source": "HC3", "domain": domain,
                "source_url": source_url(lang, domain),
                "original_source_url": source["original_source_url"],
                "license": "CC-BY-SA-4.0; stricter source terms apply",
                "source_license": source["source_license"], "license_url": COPYRIGHT_URL,
                "dataset": info["repo"], "dataset_revision": info["revision"],
                "source_sha256": source["sha256"], "source_row": pair["source_row"],
                "answer_index": pair[f"{label}_answer_index"],
                "group_id": pair["group_id"], "question_sha256": pair["question_sha256"],
                "split": pair["split"],
                "writer_group": "public_qa_authors_unspecified" if label == "human" else "chatgpt_hc3_2022_2023",
                "generated_model": None if label == "human" else "ChatGPT (HC3 collection; exact version unspecified)",
                "text_sha256": text_sha, "raw_char_count": char_count(text),
                "text_transformation": "none; exact complete source answer",
            })
    for lang, language_pairs in by_lang.items():
        options = sorted(
            (p for p in language_pairs if p["split"] == "test"),
            key=lambda p: digest(f"{seed}:mixed:{p['group_id']}"),
        )
        added = 0
        for pair in options:
            if added >= mixed_per_language:
                break
            text = pair["human"] + "\n\n" + pair["ai"]
            # Do not crop originals to force a target ratio or length.
            if char_count(text) > (3500 if lang == "en" else 2500) or digest(text) in all_hashes:
                continue
            prefix = f"hc3-{lang}-{pair['domain']}-{pair['source_row']:05d}"
            human_id, ai_id = prefix + "-human", prefix + "-ai"
            base = next(r for r in records if r["id"] == human_id)
            item = dict(base)
            item_id = prefix + "-mixed"
            filename = f"samples/{item_id}.txt"
            (out / filename).write_bytes(text.encode("utf-8"))
            item.update({
                "id": item_id, "file": filename, "label": "mixed",
                "writer_group": "constructed_full_answer_concat", "answer_index": None,
                "generated_model": "human + ChatGPT (HC3; exact version unspecified)",
                "text_sha256": digest(text), "raw_char_count": char_count(text),
                "text_transformation": "complete human answer + two LF + complete AI answer; no editing or truncation",
                "mixed_method": "concat_complete_paired_answers_human_then_ai",
                "components": [
                    {"id": human_id, "label": "human", "text_sha256": digest(pair["human"]), "chars": char_count(pair["human"])},
                    {"id": ai_id, "label": "ai", "text_sha256": digest(pair["ai"]), "chars": char_count(pair["ai"])},
                ],
                "mixed_ai_char_fraction": char_count(pair["ai"]) / (char_count(pair["human"]) + char_count(pair["ai"])),
            })
            records.append(item)
            all_hashes.add(item["text_sha256"])
            added += 1
        if added < mixed_per_language:
            raise ValueError(f"Only {added} complete-answer mixed samples fit the length limit for {lang}")
    manifest = out / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records), encoding="utf-8")
    counts = Counter(f"{r['lang']}:{r['split']}:{r['label']}" for r in records)
    summary = {
        "schema_version": 1, "seed": seed, "datasets": DATASETS,
        "sources": [{"lang": lang, "domain": domain, "url": source_url(lang, domain), **data} for (lang, domain), data in SOURCES.items()],
        "selection": "round-robin domains; SHA256 seeded row order; first eligible complete human and AI answer; no score access",
        "length_limits_nonwhitespace_chars": LENGTHS,
        "split": "50/50 per language; paired question groups and constructed mixed stay together; duplicate answers excluded",
        "counts": dict(sorted(counts.items())),
        "domain_pairs": dict(sorted(Counter(f"{p['lang']}:{p['domain']}" for p in pairs).items())),
        "manifest_sha256": digest(manifest.read_bytes()),
        "limitations": [
            "Public Q&A pilot, not a representative student-essay dataset.",
            "2022/2023 ChatGPT corpus; exact generation model version is unspecified.",
            "Human authors' native language, demographics and individual identities are unknown.",
            "Detector training overlap with HC3 cannot be ruled out; this is not independent out-of-distribution validation.",
            "Mixed samples are constructed full-answer concatenations, not observed coauthored essays, and are excluded from binary calibration.",
            "Source license statements come from HC3's maintainers; this script does not grant rights beyond those terms.",
        ],
        "paper_url": PAPER_URL, "license_url": COPYRIGHT_URL,
    }
    (out / "preparation.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--pairs-per-language", type=int, default=60)
    parser.add_argument("--mixed-per-language", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20261002)
    args = parser.parse_args()
    out = args.out.resolve()
    # Keep sample text out of tracked application directories by construction.
    private_root = (REPO_ROOT / "experiments" / "benchmark-private").resolve()
    if not out.is_relative_to(private_root):
        parser.error("--out must be inside experiments/benchmark-private (the git-ignored benchmark directory)")
    if args.pairs_per_language < 2 or args.pairs_per_language % 2 or args.mixed_per_language < 0:
        parser.error("--pairs-per-language must be even and >= 2; --mixed-per-language must be >= 0")
    pools = {}
    for lang, domain in SOURCES:
        path = fetch_source(out, lang, domain)
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        pools[lang, domain] = candidates(rows, lang, domain, args.seed)
    pairs = choose_pairs(pools, args.pairs_per_language, args.seed)
    summary = write_corpus(out, pairs, mixed_per_language=args.mixed_per_language, seed=args.seed)
    print(json.dumps({"manifest": str(out / "manifest.jsonl"), "counts": summary["counts"], "manifest_sha256": summary["manifest_sha256"]}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        # Never print source rows or answer bodies on failures.
        print(f"Corpus preparation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
