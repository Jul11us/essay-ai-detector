"""Regression checks for provenance, full-answer preservation and split leakage."""

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_benchmark.py"
_SPEC = importlib.util.spec_from_file_location("prepare_benchmark", _SCRIPT)
prepare = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prepare)


def source_rows(lang, count=12):
    base = (
        "完整的中文回答保持原稿措辞，解释具体原因和事实。" * 12
        if lang == "zh"
        else "A complete source answer discusses this question in detail. " * 10
    )
    return [
        {
            "question": f"{lang} question {index}",
            "human_answers": ["too short", f"human {index}\n\n{base}"],
            "chatgpt_answers": [f"generated {index}\n\n{base}"],
        }
        for index in range(count)
    ]


def test_complete_original_answers_and_constructed_mixed_are_preserved(tmp_path):
    pools = {
        ("en", "wiki_csai"): prepare.candidates(source_rows("en"), "en", "wiki_csai", 7),
        ("zh", "open_qa"): prepare.candidates(source_rows("zh"), "zh", "open_qa", 7),
    }
    pairs = prepare.choose_pairs(pools, 8, 7)
    summary = prepare.write_corpus(tmp_path, pairs, mixed_per_language=2, seed=7)
    manifest = tmp_path / "manifest.jsonl"
    rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines()]
    by_id = {row["id"]: row for row in rows}
    for row in rows:
        text = (tmp_path / row["file"]).read_bytes().decode("utf-8")
        assert prepare.digest(text) == row["text_sha256"]
        assert row["source_url"].endswith(f"/{row['domain']}.jsonl")
        if row["label"] != "mixed":
            source = source_rows(row["lang"])[row["source_row"]]
            field = "human_answers" if row["label"] == "human" else "chatgpt_answers"
            assert text == source[field][row["answer_index"]]
        else:
            first, second = [by_id[component["id"]] for component in row["components"]]
            assert row["split"] == first["split"] == second["split"] == "test"
            assert row["group_id"] == first["group_id"] == second["group_id"]
            assert text == (tmp_path / first["file"]).read_bytes().decode("utf-8") + "\n\n" + (
                tmp_path / second["file"]
            ).read_bytes().decode("utf-8")
    assert summary["counts"]["en:calibration:human"] == 4
    assert summary["counts"]["zh:test:mixed"] == 2
    before = manifest.read_bytes()
    prepare.write_corpus(tmp_path, pairs, mixed_per_language=2, seed=7)
    assert manifest.read_bytes() == before


def test_duplicate_question_and_whitespace_variant_answer_never_leak_across_splits():
    for lang, domain in (("en", "wiki_csai"), ("zh", "open_qa")):
        rows = source_rows(lang, 14)
        question_duplicate = dict(rows[0], question="  " + rows[0]["question"].replace(" ", "  "))
        answer_duplicate = dict(
            rows[1],
            question="separate question",
            human_answers=[rows[1]["human_answers"][1].replace(" ", "  ")],
        )
        pool = prepare.candidates(rows + [question_duplicate, answer_duplicate], lang, domain, 7)
        pairs = prepare.choose_pairs({(lang, domain): pool}, 12, 7)
        assert len({p["group_id"] for p in pairs}) == len(pairs)
        texts = [" ".join(p[label].split()) for p in pairs for label in ("human", "ai")]
        assert len(texts) == len(set(texts))
        assert sum(p["split"] == "calibration" for p in pairs) == 6


def test_checksum_mismatch_refuses_corrupted_cache_without_network(tmp_path, monkeypatch):
    raw = tmp_path / "raw" / "en-wiki_csai.jsonl"
    raw.parent.mkdir()
    raw.write_bytes(b"corrupted")
    monkeypatch.setattr(
        prepare.urllib.request,
        "urlopen",
        lambda *args, **kwargs: pytest.fail("must not download after a cached checksum failure"),
    )
    with pytest.raises(ValueError, match="checksum mismatch"):
        prepare.fetch_source(tmp_path, "en", "wiki_csai")


def test_overlong_original_is_skipped_instead_of_cropped():
    row = source_rows("en", 1)[0]
    row["human_answers"] = ["a" * 2501]
    assert prepare.candidates([row], "en", "wiki_csai", 7) == []


def test_missing_pairs_fail_instead_of_silently_shrinking_the_evaluation():
    pools = {("en", "wiki_csai"): prepare.candidates(source_rows("en", 3), "en", "wiki_csai", 7)}
    with pytest.raises(ValueError, match="Not enough distinct eligible"):
        prepare.choose_pairs(pools, 4, 7)
