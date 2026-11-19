"""Regression checks for the English corpus: provenance, eligibility and split leakage."""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_english_benchmark.py"
_SPEC = importlib.util.spec_from_file_location("prepare_english_benchmark", _SCRIPT)
prepare = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prepare)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import benchmark  # noqa: E402


def essay(tag, index):
    return f"{tag} essay {index} opening.\n\n" + f"Paragraph about {tag} topic {index} with reasons and examples. " * 12


def fake_ghost(out, folder, index):
    return essay(f"ghost-{folder}", index)


def fake_fetch(out, name):
    if name == "ellipse_train.csv":
        lines = ["text_id_kaggle,full_text,grade,prompt"]
        lines += [f'E{i},"{essay("ell", i)}",10,Prompt {i % 3}' for i in range(10)]
        return "\n".join(lines).encode()
    if name.startswith("argugpt"):
        lines = ["id,prompt_id,model,text"]
        model = "gpt-3.5-turbo" if "test" in name else "gpt4"
        lines += [f'{i},P{i % 2},{model},"{essay(name + model, i)}"' for i in range(10)]
        return "\n".join(lines).encode()
    rows = [{"text": essay("arxiv-human", i), "label": "human"} for i in range(6)]
    rows += [{"text": essay("arxiv-ai", i), "label": "llm", "llm_type": "ChatGPT"} for i in range(6)]
    return json.dumps(rows).encode()


QUOTAS = {
    ("ghostbuster", "pairs", "gpt-3.5-turbo"): 4,
    ("ghostbuster", "ai", "claude"): 2,
    ("ellipse", "human", None): 4,
    ("argugpt", "ai", "gpt-3.5-turbo"): 2,
    ("argugpt", "ai", "gpt4"): 2,
    ("detectrl", "human", None): 4,
    ("detectrl", "ai", "ChatGPT"): 4,
}


def build(tmp_path, seed=3):
    items = prepare.select(tmp_path, QUOTAS, seed, fetch_ghost=fake_ghost, fetch=fake_fetch)
    prepare.assign_splits(items, seed)
    return prepare.write_corpus(tmp_path, items, seed)


def test_manifest_preserves_exact_text_provenance_and_passes_benchmark_validation(tmp_path):
    summary = build(tmp_path)
    manifest = tmp_path / "manifest.jsonl"
    rows = benchmark.load_manifest(manifest)
    assert len(rows) == 4 * 2 + 2 + 4 + 2 + 2 + 4 + 4
    for row in rows:
        text = (tmp_path / row["file"]).read_bytes().decode("utf-8")
        assert prepare.digest(text) == row["text_sha256"]
        assert row["lang"] == "en" and row["training_overlap"] == "unknown"
        assert row["dataset_revision"] in row["source_url"]
        assert (row["label"] == "ai") == bool(row["generated_model"])
    assert {r["domain"] for r in rows} == {"composition", "paper"}
    assert summary["manifest_sha256"] == prepare.digest(manifest.read_bytes())


def test_pairs_and_shared_prompts_never_cross_splits(tmp_path):
    build(tmp_path)
    rows = [json.loads(line) for line in (tmp_path / "manifest.jsonl").read_text().splitlines()]
    splits = {}
    for row in rows:
        assert splits.setdefault(row["group_id"], row["split"]) == row["split"]
    ghost_pairs = [r for r in rows if r["group_id"].startswith("ghostbuster-essay-") and "claude" not in r["group_id"]]
    assert {r["label"] for r in ghost_pairs} == {"human", "ai"}
    assert {r["split"] for r in rows} == {"calibration", "test"}


def test_generation_is_deterministic(tmp_path):
    first = build(tmp_path / "a")["manifest_sha256"]
    assert build(tmp_path / "b")["manifest_sha256"] == first


@pytest.mark.parametrize("text", ["too short", "中文" * 400, "word " * 3000, None])
def test_ineligible_texts_are_rejected(text):
    assert not prepare.eligible(text)


def test_shortfall_and_checksum_mismatch_fail_loudly(tmp_path):
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select(tmp_path, {("ellipse", "human", None): 50}, 1, fetch_ghost=fake_ghost, fetch=fake_fetch)
    raw = tmp_path / "raw" / "ellipse_train.csv"
    raw.parent.mkdir(parents=True)
    raw.write_text("tampered")
    with pytest.raises(ValueError, match="checksum mismatch"):
        prepare.fetch_file(tmp_path, "ellipse_train.csv")
