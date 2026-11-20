"""PERSUADE metadata filters, prompt isolation, deduplication and source pins."""
import importlib.util
import json
from collections import Counter
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_secondary_school_benchmark.py"
_SPEC = importlib.util.spec_from_file_location("prepare_secondary_school", _SCRIPT)
prepare = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prepare)


def essays():
    return [dict(essay_id_comp=f"essay{i}", full_text=f"Essay {i}. " + "This student wrote a sufficiently long English essay. " * 15,
                 prompt_name=f"Prompt {i // 3}", grade_level=str(6 + i % 7), ell_status="No", assignment=f"Assignment {i // 3}")
            for i in range(12)]


def test_deterministic_prompt_isolation_balancing_and_provenance(tmp_path):
    source = essays()
    rows = prepare.select(source + source, {"prompt-0", "prompt-1"}, set(), 4, 7)
    assert rows == prepare.select(list(reversed(source)), {"prompt-0", "prompt-1"}, set(), 4, 7)
    assert Counter((r["split"], r["prompt_key"]) for r in rows) == Counter({("dev", "prompt-0"): 2, ("dev", "prompt-1"): 2, ("test", "prompt-2"): 2, ("test", "prompt-3"): 2})
    summary = prepare.write_corpus(tmp_path, rows, 7, "reference")
    records = list(map(json.loads, (tmp_path / "manifest.jsonl").read_text().splitlines()))
    assert len(records) == 8
    assert summary["manifest_sha256"] == prepare.digest((tmp_path / "manifest.jsonl").read_bytes())
    groups = {}
    for r in records:
        assert groups.setdefault(r["group_id"], r["split"]) == r["split"]
        assert r["license"] == "CC-BY-4.0" and r["ell_status"] == "No"
        assert 6 <= r["grade_level"] <= 12 and "proxy" in r["native_language"]
        assert prepare.REVISION in r["source_url"] and r["source_sha256"] == prepare.FILES[prepare.DATA_FILE]["sha256"]
        assert r["training_overlap"] == "unknown"
        assert prepare.digest((tmp_path / r["file"]).read_bytes()) == r["text_sha256"]


@pytest.mark.parametrize("field,value", [("ell_status", "Yes"), ("ell_status", ""), ("grade_level", ""), ("grade_level", "5"), ("grade_level", "13"), ("full_text", "Short"), ("full_text", "x" * 8001)])
def test_ineligible_metadata_or_text_cannot_fill_quota(field, value):
    rows = essays()
    for r in rows:
        r[field] = value
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select(rows, {"prompt-0"}, set(), 1)


def test_empty_invalid_quota_exclusions_and_conflicting_discourse_rows():
    with pytest.raises(ValueError, match="positive"):
        prepare.select([], set(), set(), 0)
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select([], set(), set(), 1)
    rows = essays()
    excluded = {prepare.digest(prepare.normalized(r["full_text"])) for r in rows[:3]}
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select(rows, {"prompt-0"}, excluded, 1)
    with pytest.raises(ValueError, match="Inconsistent"):
        prepare.unique_essays([rows[0], dict(rows[0], ell_status="Yes")])
    with pytest.raises(ValueError, match="Missing"):
        prepare.unique_essays([dict(rows[0], essay_id_comp="")])


def test_normalized_duplicates_and_source_checksum_failure(tmp_path):
    rows = essays()
    for r in rows:
        r["full_text"] = rows[0]["full_text"] + "  "
    with pytest.raises(ValueError, match="Not enough"):
        prepare.select(rows, {"prompt-0"}, set(), 1)
    path = tmp_path / "raw" / "README.md"
    path.parent.mkdir()
    path.write_text("tampered")
    with pytest.raises(ValueError, match="checksum mismatch"):
        prepare.fetch_file(tmp_path, "README.md")
