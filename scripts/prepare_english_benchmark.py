"""Prepare a reproducible English essay/paper benchmark from pinned public corpora.

Measures English false flags (human text judged high) and misses (AI text judged
low) on student compositions, non-native learner essays and paper abstracts.
Downloads only commit-pinned public files; sample text stays in the git-ignored
benchmark directory and stdout reports counts and checksums only.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = REPO_ROOT / "experiments" / "benchmark-private"
DEFAULT_OUT = PRIVATE_ROOT / "public-en"
GHOSTBUSTER_COMMIT = "86ebd72590556a81622986fab736ab9227a948af"
GHOSTBUSTER_RAW = (
    f"https://raw.githubusercontent.com/vivek3141/ghostbuster-data/{GHOSTBUSTER_COMMIT}/essay"
)
ARGUGPT_COMMIT = "cfbd00e75b63db44756375cfc1ee4278f8cd2bf1"
ARGUGPT_RAW = (
    f"https://raw.githubusercontent.com/huhailinguist/ArguGPT/{ARGUGPT_COMMIT}/data/argugpt"
)
# Bulk files are pinned by commit and SHA-256; mismatches abort preparation.
FILES = {
    "ellipse_train.csv": {
        "url": "https://raw.githubusercontent.com/scrosseye/ELLIPSE-Corpus/710963bbf1acf23a28e40643d9f937d06f047dd4/ELLIPSE_Final_github_train.csv",
        "sha256": "782344e99668a3ff508d7410c0eb6e36da70f3b28f81c96e367f1ca04924b06c",
    },
    "argugpt_machine_test.csv": {
        "url": f"{ARGUGPT_RAW}/machine-test.csv",
        "sha256": "2cdff95bf1f73de2ab8c6419f8934e0e6c42c47628e0f3c11d417fc1d725fc3b",
    },
    "argugpt_machine_ood.csv": {
        "url": f"{ARGUGPT_RAW}/machine-ood.csv",
        "sha256": "a929905a1b2f4e3f1f206755c5a0f6cb4002c1a62b6fc59158cf79c8d260de86",
    },
    "detectrl_arxiv_test.json": {
        "url": "https://raw.githubusercontent.com/NLP2CT/DetectRL/3472f0ae3cc81133c821e901f6d5c8f79c60dd23/Benchmark/Benchmark_Data/Multi_Domain/multi_domains_arxiv_test.json",
        "sha256": "909b4e896c0ff85cc0ea99dca405a2a930e7ee61d50176649a2716fb87e5f1cf",
    },
}
DETECTRL_RAW = "https://raw.githubusercontent.com/NLP2CT/DetectRL/3472f0ae3cc81133c821e901f6d5c8f79c60dd23/Benchmark/Benchmark_Data/Multi_Domain"
for _domain, _sha in {
    "xsum": "c2eb61da032e842b7b38552857953c0e695e9c4edd22eaa770766e478d66e741",
    "writing_prompt": "7e224409cb3b149cb4c059123275b44209b44732e2d54d9d5828e8fb93b00851",
    "yelp_review": "041b07d6c9a8f224ae7c77e8a4202c08ac2c01c2ca5b21becb7fe60d27b68f66",
}.items():
    FILES[f"detectrl_{_domain}_test.json"] = {
        "url": f"{DETECTRL_RAW}/multi_domains_{_domain}_test.json",
        "sha256": _sha,
    }
SOURCES = {
    "ghostbuster": {
        "source": "Ghostbuster essay",
        "domain": "composition",
        "source_url": f"https://github.com/vivek3141/ghostbuster-data/tree/{GHOSTBUSTER_COMMIT}/essay",
        "license": "CC-BY-3.0 (Ghostbuster data); human essays originate from IvyPanda",
        "dataset_revision": GHOSTBUSTER_COMMIT,
        "paper_url": "https://arxiv.org/abs/2305.15047",
    },
    "ellipse": {
        "source": "ELLIPSE corpus",
        "domain": "composition",
        "source_url": FILES["ellipse_train.csv"]["url"],
        "license": "CC-BY-4.0",
        "dataset_revision": "710963bbf1acf23a28e40643d9f937d06f047dd4",
        "paper_url": "https://doi.org/10.1075/ijlcr.22026.cro",
    },
    "argugpt": {
        "source": "ArguGPT machine essays",
        "domain": "composition",
        "source_url": f"https://github.com/huhailinguist/ArguGPT/tree/{ARGUGPT_COMMIT}/data/argugpt",
        "license": "no license file in the repository; local evaluation only, do not redistribute",
        "dataset_revision": ARGUGPT_COMMIT,
        "paper_url": "https://arxiv.org/abs/2304.07666",
    },
    "detectrl": {
        "source": "DetectRL arXiv abstracts",
        "domain": "paper",
        "source_url": FILES["detectrl_arxiv_test.json"]["url"],
        "license": "no license file in the repository; arXiv abstracts; local evaluation only, do not redistribute",
        "dataset_revision": "3472f0ae3cc81133c821e901f6d5c8f79c60dd23",
        "paper_url": "https://arxiv.org/abs/2410.23746",
    },
}
# Single-paragraph set: one-paragraph English texts that the document coverage rule used to
# keep out of `high`; every sample is test-only so it can check, never fit, that rule.
SINGLE_PARAGRAPH_DOMAINS = {"xsum": "news", "writing_prompt": "story", "yelp_review": "review"}
SINGLE_PARAGRAPH_ELLIPSE = 150
SINGLE_PARAGRAPH_PER_DOMAIN = 60
# Defaults: (source, label, generator) -> sample count. Generators chosen for
# realistic essay quality; GPT-2/babbage/curie/bloomz/flan-t5 essays are excluded.
DEFAULT_QUOTAS = {
    ("ghostbuster", "pairs", "gpt-3.5-turbo"): 120,
    ("ghostbuster", "ai", "claude"): 40,
    ("ellipse", "human", None): 120,
    ("argugpt", "ai", "gpt-3.5-turbo"): 40,
    ("argugpt", "ai", "gpt4"): 40,
    ("argugpt", "ai", "claude-instant"): 40,
    ("detectrl", "human", None): 120,
    ("detectrl", "ai", "ChatGPT"): 30,
    ("detectrl", "ai", "Claude-instant"): 30,
    ("detectrl", "ai", "Google-PaLM"): 30,
    ("detectrl", "ai", "Llama-2-70b"): 30,
}
MIN_CHARS, MAX_CHARS = 400, 8000
_WHITESPACE = re.compile(r"\s+")
_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_LATIN = re.compile(r"[A-Za-z]")


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def char_count(text: str) -> int:
    return len(_WHITESPACE.sub("", text))


def eligible(text: object) -> bool:
    """Length and language rules only; never model scores or style filters."""
    if not isinstance(text, str) or not MIN_CHARS <= char_count(text) <= MAX_CHARS:
        return False
    cjk, latin = len(_CJK.findall(text)), len(_LATIN.findall(text))
    return latin >= 200 and cjk / max(1, cjk + latin) < 0.15


def order_key(seed: int, *parts: object) -> str:
    return digest(":".join(str(p) for p in (seed, *parts)))


def _download(url: str, limit: int = 60_000_000) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "essay-ai-detector-en-benchmark/1"}
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        expected = response.headers.get("Content-Length")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Source exceeds the expected download size")
    if expected is not None and len(data) != int(expected):
        raise ValueError(f"Truncated download: {url}")
    return data


def fetch_file(out: Path, name: str) -> bytes:
    path, expected = out / "raw" / name, FILES[name]["sha256"]
    if path.exists():
        data = path.read_bytes()
        if digest(data) != expected:
            raise ValueError(
                f"Cached source checksum mismatch: {name}; remove that raw file and retry"
            )
        return data
    data = _download(FILES[name]["url"])
    if digest(data) != expected:
        raise ValueError(f"Downloaded source checksum mismatch: {name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def fetch_ghostbuster(out: Path, folder: str, index: int) -> str:
    """Single essay files are immutable at the pinned commit; cached copies are reused."""
    path = out / "raw" / "ghostbuster" / folder / f"{index}.txt"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        partial.write_bytes(_download(f"{GHOSTBUSTER_RAW}/{folder}/{index}.txt", 1_000_000))
        partial.replace(path)
    return path.read_bytes().decode("utf-8")


def _item(source: str, key: str, label: str, text: str, group_id: str, **extra) -> dict:
    return {
        "source_key": source,
        "key": key,
        "label": label,
        "text": text,
        "group_id": group_id,
        **extra,
    }


def pick(pool: list[dict], count: int, seed: int, what: str, seen: set[str]) -> list[dict]:
    chosen = []
    for item in sorted(pool, key=lambda i: order_key(seed, "sample", i["source_key"], i["key"])):
        if len(chosen) >= count:
            break
        texts = [item["text"]] + ([item["paired_text"]] if "paired_text" in item else [])
        hashes = {digest(" ".join(t.split())) for t in texts}
        if not all(eligible(t) for t in texts) or len(hashes) != len(texts) or hashes & seen:
            continue
        seen.update(hashes)
        chosen.append(item)
    if len(chosen) < count:
        raise ValueError(f"Not enough distinct eligible samples for {what}: {len(chosen)}/{count}")
    return chosen


def select(
    out: Path, quotas: dict, seed: int, fetch_ghost=fetch_ghostbuster, fetch=fetch_file
) -> list[dict]:
    seen: set[str] = set()
    items: list[dict] = []
    ghost_pairs = quotas.get(("ghostbuster", "pairs", "gpt-3.5-turbo"), 0)
    ghost_claude = quotas.get(("ghostbuster", "ai", "claude"), 0)
    if ghost_pairs or ghost_claude:
        indices = sorted(range(1, 1001), key=lambda i: order_key(seed, "ghostbuster", i))
        pairs: list[dict] = []
        for index in indices:
            if len(pairs) >= ghost_pairs:
                break
            human, ai = fetch_ghost(out, "human", index), fetch_ghost(out, "gpt", index)
            pairs.extend(
                pick(
                    [
                        _item(
                            "ghostbuster",
                            str(index),
                            "human",
                            human,
                            f"ghostbuster-essay-{index}",
                            paired_text=ai,
                            generated_model="gpt-3.5-turbo",
                        )
                    ],
                    1,
                    seed,
                    "ghostbuster",
                    seen,
                )
                if eligible(human) and eligible(ai)
                else []
            )
        if len(pairs) < ghost_pairs:
            raise ValueError(f"Not enough Ghostbuster human/GPT essay pairs: {len(pairs)}")
        for pair in pairs:
            items.append(
                dict(
                    pair,
                    label="human",
                    generated_model=None,
                    writer_group="ivypanda_essay_authors_unspecified",
                )
            )
            items.append(
                dict(
                    pair,
                    label="ai",
                    text=pair["paired_text"],
                    writer_group="ghostbuster_gpt-3.5-turbo_2023",
                )
            )
        claude: list[dict] = []
        for index in indices:
            if len(claude) >= ghost_claude:
                break
            text = fetch_ghost(out, "claude", index)
            if eligible(text):
                claude.extend(
                    pick(
                        [
                            _item(
                                "ghostbuster",
                                f"claude-{index}",
                                "ai",
                                text,
                                f"ghostbuster-essay-claude-{index}",
                                generated_model="claude (Ghostbuster 2023)",
                                writer_group="ghostbuster_claude_2023",
                            )
                        ],
                        1,
                        seed,
                        "ghostbuster claude",
                        seen,
                    )
                )
        if len(claude) < ghost_claude:
            raise ValueError(f"Not enough Ghostbuster Claude essays: {len(claude)}")
        items.extend(claude)
    if quotas.get(("ellipse", "human", None)):
        rows = list(
            csv.DictReader(
                io.StringIO(fetch(out, "ellipse_train.csv").decode("utf-8", errors="replace"))
            )
        )
        pool = [
            _item(
                "ellipse",
                r["text_id_kaggle"],
                "human",
                r["full_text"],
                f"ellipse-prompt-{re.sub(r'[^a-z0-9]+', '-', r['prompt'].lower()).strip('-')}",
                writer_group="ell_students_grade8_12",
                grade=r.get("grade"),
                prompt_name=r.get("prompt"),
            )
            for r in rows
        ]
        items.extend(pick(pool, quotas["ellipse", "human", None], seed, "ellipse", seen))
    argu = {model: n for (src, _, model), n in quotas.items() if src == "argugpt" and n}
    if argu:
        rows = [
            dict(r, _file="machine-test.csv")
            for r in csv.DictReader(
                io.StringIO(fetch(out, "argugpt_machine_test.csv").decode("utf-8"))
            )
        ]
        rows += [
            dict(r, _file="machine-ood.csv")
            for r in csv.DictReader(
                io.StringIO(fetch(out, "argugpt_machine_ood.csv").decode("utf-8"))
            )
        ]
        for model, count in argu.items():
            # The in-distribution test split holds GPT-3.5 essays on TOEFL/WECCL/GRE prompts;
            # GPT-4 and Claude-instant essays exist only in the OOD prompt set.
            wanted_file = "machine-test.csv" if model == "gpt-3.5-turbo" else "machine-ood.csv"
            pool = [
                _item(
                    "argugpt",
                    f"{r['_file']}:{r['id']}",
                    "ai",
                    r["text"],
                    f"argugpt-{r['prompt_id']}",
                    generated_model=model,
                    writer_group=f"argugpt_{model}_2023",
                    prompt_id=r["prompt_id"],
                )
                for r in rows
                if r["model"] == model and r["_file"] == wanted_file
            ]
            items.extend(pick(pool, count, seed, f"argugpt {model}", seen))
    detect = {
        (label, model): n for (src, label, model), n in quotas.items() if src == "detectrl" and n
    }
    if detect:
        rows = json.loads(fetch(out, "detectrl_arxiv_test.json"))
        for (label, model), count in detect.items():
            if label == "human":
                pool = [
                    _item(
                        "detectrl",
                        f"{i}",
                        "human",
                        r["text"],
                        f"detectrl-arxiv-{digest(' '.join(r['text'].split()))[:20]}",
                        writer_group="arxiv_authors_unspecified",
                    )
                    for i, r in enumerate(rows)
                    if r.get("label") == "human"
                ]
            else:
                pool = [
                    _item(
                        "detectrl",
                        f"{i}",
                        "ai",
                        r["text"],
                        f"detectrl-arxiv-{digest(' '.join(r['text'].split()))[:20]}",
                        generated_model=model,
                        writer_group=f"detectrl_{model}",
                        generation_method=r["data_type"],
                    )
                    for i, r in enumerate(rows)
                    if r.get("label") == "llm" and r.get("llm_type") == model
                ]
            items.extend(pick(pool, count, seed, f"detectrl {label} {model}", seen))
    return items


def single_paragraph(text: str) -> bool:
    return len([line for line in text.splitlines() if line.strip()]) == 1


def select_single_paragraph(
    out: Path,
    seed: int,
    fetch=fetch_file,
    *,
    ellipse: int = SINGLE_PARAGRAPH_ELLIPSE,
    per_domain: int = SINGLE_PARAGRAPH_PER_DOMAIN,
) -> list[dict]:
    seen: set[str] = set()
    rows = list(
        csv.DictReader(
            io.StringIO(fetch(out, "ellipse_train.csv").decode("utf-8", errors="replace"))
        )
    )
    pool = [
        _item(
            "ellipse",
            r["text_id_kaggle"],
            "human",
            r["full_text"],
            f"ellipse-{r['text_id_kaggle']}",
            writer_group="ell_students_grade8_12",
            grade=r.get("grade"),
            prompt_name=r.get("prompt"),
            domain="composition",
        )
        for r in rows
        if single_paragraph(r["full_text"])
    ]
    items = pick(pool, ellipse, seed, "single-paragraph ellipse", seen)
    for name, domain in SINGLE_PARAGRAPH_DOMAINS.items():
        data = json.loads(fetch(out, f"detectrl_{name}_test.json"))
        for label in ("human", "ai"):
            raw = "human" if label == "human" else "llm"
            pool = [
                _item(
                    "detectrl",
                    f"{name}-{i}",
                    label,
                    r["text"],
                    f"detectrl-{name}-{digest(' '.join(r['text'].split()))[:20]}",
                    domain=domain,
                    source_name=f"DetectRL {domain}",
                    source_url=FILES[f"detectrl_{name}_test.json"]["url"],
                    writer_group="detectrl_human_unspecified"
                    if label == "human"
                    else f"detectrl_{r.get('llm_type')}",
                    generated_model=r.get("llm_type") if label == "ai" else None,
                    generation_method=r.get("data_type") if label == "ai" else None,
                )
                for i, r in enumerate(data)
                if r.get("label") == raw and single_paragraph(r["text"])
            ]
            items.extend(pick(pool, per_domain, seed, f"single-paragraph {name} {label}", seen))
    for item in items:
        item["split"] = "test"
    return items


def assign_splits(items: list[dict], seed: int) -> None:
    """Alternate whole groups within each source/label stratum: pairs and same-prompt essays never cross splits."""
    strata: dict[tuple, list[str]] = defaultdict(list)
    group_split: dict[str, str] = {}
    for item in items:
        if item["source_key"] == "detectrl":
            # DetectRL has no paper id linking an abstract to its LLM versions; keep all of it out of fitting.
            group_split[item["group_id"]] = "test"
            continue
        stratum = (
            item["source_key"],
            "pair" if "paired_text" in item else item["label"],
            item.get("generated_model"),
        )
        if item["group_id"] not in strata[stratum]:
            strata[stratum].append(item["group_id"])
    for stratum in sorted(strata, key=str):
        groups = [
            g
            for g in sorted(strata[stratum], key=lambda g: order_key(seed, "split", g))
            if g not in group_split
        ]
        for index, group in enumerate(groups):
            group_split[group] = "calibration" if index % 2 == 0 else "test"
    for item in items:
        item["split"] = group_split[item["group_id"]]


def write_corpus(out: Path, items: list[dict], seed: int, *, split_note: str | None = None) -> dict:
    samples = out / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    records = []
    for item in items:
        src = SOURCES[item["source_key"]]
        safe_key = re.sub(r"[^A-Za-z0-9-]+", "-", item["key"]).strip("-")
        model = re.sub(r"[^A-Za-z0-9.-]+", "-", item.get("generated_model") or "human").lower()
        item_id = f"en-{item['source_key']}-{safe_key}-{item['label']}-{model}"[:120]
        filename = f"samples/{item_id}.txt"
        (out / filename).write_bytes(item["text"].encode("utf-8"))
        record = {
            "id": item_id,
            "file": filename,
            "lang": "en",
            "label": item["label"],
            "source": item.get("source_name", src["source"]),
            "domain": item.get("domain", src["domain"]),
            "source_url": item.get("source_url", src["source_url"]),
            "license": src["license"],
            "dataset_revision": src["dataset_revision"],
            "group_id": item["group_id"],
            "split": item["split"],
            "writer_group": item["writer_group"],
            "generated_model": item.get("generated_model"),
            "source_key": item["key"],
            "training_overlap": "unknown",
            "text_sha256": digest(item["text"]),
            "raw_char_count": char_count(item["text"]),
            "text_transformation": "none; exact complete source text",
        }
        for key in ("grade", "prompt_name", "prompt_id", "generation_method"):
            if item.get(key):
                record[key] = item[key]
        records.append(record)
    records.sort(key=lambda r: r["id"])
    if len({r["id"] for r in records}) != len(records):
        raise ValueError("Sample ids collide")
    manifest = out / "manifest.jsonl"
    manifest.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8"
    )
    counts = Counter(f"{r['domain']}:{r['split']}:{r['label']}" for r in records)
    summary = {
        "schema_version": 1,
        "seed": seed,
        "files": FILES,
        "sources": SOURCES,
        "selection": "SHA256-seeded order per source/generator; first eligible complete texts; no model scores read",
        "length_limits_nonwhitespace_chars": [MIN_CHARS, MAX_CHARS],
        "split": split_note
        or "whole groups alternate within each source/label/generator stratum; DetectRL abstracts are test-only because their LLM versions cannot be linked to source abstracts",
        "counts": dict(sorted(counts.items())),
        "by_writer_group": dict(
            sorted(
                Counter(f"{r['domain']}:{r['label']}:{r['writer_group']}" for r in records).items()
            )
        ),
        "manifest_sha256": digest(manifest.read_bytes()),
        "limitations": [
            "AI essays come from 2023-era generators (GPT-3.5, GPT-4, Claude/Claude-instant, PaLM-2, Llama-2); newer models are not covered.",
            "Human and AI composition samples come from different corpora except the paired Ghostbuster essays; corpus style differences can inflate or hide errors.",
            "ELLIPSE essays are by US grade 8-12 English learners, not Chinese students; ArguGPT AI essays answer TOEFL/WECCL/GRE-style prompts.",
            "Detector training overlap is unknown; Vanguard trained on DACTYL 2.0, LLMTrace and MAGA-Bench and lists DetectRL as out-of-distribution.",
            "arXiv abstracts are single paragraphs, so the current coverage rule can only return low or uncertain for them.",
        ],
    }
    (out / "preparation.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--seed", type=int, default=20261119)
    parser.add_argument("--set", choices=("default", "single-paragraph"), default="default")
    args = parser.parse_args()
    if args.set == "single-paragraph" and args.out == DEFAULT_OUT:
        args.out = PRIVATE_ROOT / "public-en-single-paragraph"
    out = args.out.resolve()
    if not out.is_relative_to(PRIVATE_ROOT.resolve()):
        parser.error(
            "--out must be inside experiments/benchmark-private (the git-ignored benchmark directory)"
        )
    if args.set == "single-paragraph":
        items = select_single_paragraph(out, args.seed)
        summary = write_corpus(
            out, items, args.seed, split_note="test only; checks the single-paragraph coverage rule"
        )
    else:
        items = select(out, DEFAULT_QUOTAS, args.seed)
        assign_splits(items, args.seed)
        summary = write_corpus(out, items, args.seed)
    print(
        json.dumps(
            {
                "manifest": str(out / "manifest.jsonl"),
                "counts": summary["counts"],
                "manifest_sha256": summary["manifest_sha256"],
            },
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f"Corpus preparation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
