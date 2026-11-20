"""Pinned composition builder selection, provenance and leakage checks."""
import importlib.util
import json
from collections import Counter
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_chinese_composition_benchmark.py"
_SPEC = importlib.util.spec_from_file_location("prepare_chinese_composition", _SCRIPT)
prepare = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prepare)


def tables():
    rows = {k: [] for k in prepare.SHA256}
    for i in range(18):
        title = f"题目{i // 2}"
        rows["human"].append(dict(id=str(i), composition_title=title, label="1", text=f"人类原文{i}" + "这是人的作文。" * 70))
        for model in prepare.MODELS:
            rows[model].append(dict(id=str(i), original_id=str(i), composition_title=title, label="0",
                                    text=f"模型{model}原文{i}" + "这是生成的作文。" * 70))
    return rows


def test_balanced_title_disjoint_deterministic_pairs_and_provenance(tmp_path):
    pairs = prepare.select(tables(), pairs_per_split=3, seed=17)
    assert pairs == prepare.select(tables(), pairs_per_split=3, seed=17)
    assert len({p["title"] for p in pairs}) == 6
    assert Counter((p["split"], p["model"]) for p in pairs) == Counter({(s, m): 1 for s in ("dev", "test") for m in prepare.MODELS})
    summary = prepare.write_corpus(tmp_path, pairs, 17)
    rows = [json.loads(line) for line in (tmp_path / "manifest.jsonl").read_text().splitlines()]
    assert len(rows) == 12
    assert summary["manifest_sha256"] == prepare.digest((tmp_path / "manifest.jsonl").read_bytes())
    assert len({r["normalized_text_sha256"] for r in rows}) == len(rows)
    groups = {}
    for row in rows:
        assert groups.setdefault(row["group_id"], row["split"]) == row["split"]
        assert row["dataset_revision"] in row["source_url"]
        assert row["training_overlap"] == "unknown" and row["genre"] == "composition" and row["lang"] == "zh"
        assert prepare.digest((tmp_path / row["file"]).read_bytes()) == row["text_sha256"]


@pytest.mark.parametrize("text", [None, "", "短文", "English " * 100, "中" * 8001])
def test_ineligible_text(text):
    assert not prepare.eligible(text)


def test_empty_shortfall_invalid_quota_and_checksum(tmp_path):
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select({k: [] for k in prepare.SHA256}, 3)
    with pytest.raises(ValueError, match="divisible"):
        prepare.select(tables(), 2)
    raw = tmp_path / "raw" / "CReD_composition_human.csv"
    raw.parent.mkdir()
    raw.write_text("tampered")
    with pytest.raises(ValueError, match="checksum mismatch"):
        prepare.fetch_file(tmp_path, "human")


def test_duplicate_text_cannot_inflate_groups():
    rows = tables()
    for row in rows["human"]:
        row["text"] = "相同文本" * 120
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select(rows, 3)
