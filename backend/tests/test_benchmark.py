from pathlib import Path

import pytest

from benchmark import load_manifest, summarize


def test_counts_false_flags_and_misses_without_treating_mixed_as_binary():
    rows = [
        {"id": "h", "lang": "en", "label": "human", "source": "test", "writer_group": "non_native"},
        {"id": "a", "lang": "en", "label": "ai", "source": "test"},
        {"id": "m", "lang": "zh", "label": "mixed", "source": "test"},
    ]
    predictions = [
        {"id": "h", "score": 0.8, "verdict": "high"},
        {"id": "a", "score": 0.1, "verdict": "low"},
        {"id": "m", "score": 0.5, "verdict": "uncertain"},
    ]
    report = summarize(rows, predictions)
    assert report["overall"]["human_high_false_flag"] == {"count": 1, "of": 1}
    assert report["overall"]["ai_low_miss"] == {"count": 1, "of": 1}
    assert report["overall"]["mixed"] == {"uncertain": 1}
    assert report["groups"]["writer_group:non_native"]["n"] == 1


def test_manifest_requires_provenance_and_local_file(tmp_path: Path):
    (tmp_path / "essay.txt").write_text("sample", encoding="utf-8")
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text('{"id":"one","file":"essay.txt","lang":"en","label":"human"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="source"):
        load_manifest(manifest)
    manifest.write_text('{"id":"one","file":"../elsewhere.txt","lang":"en","label":"human","source":"test"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="manifest directory"):
        load_manifest(manifest)
