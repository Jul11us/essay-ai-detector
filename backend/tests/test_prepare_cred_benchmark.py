import importlib.util
import io
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_cred_benchmark.py"
SPEC = importlib.util.spec_from_file_location("prepare_cred", SCRIPT)
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def rows(domain, generator, count=8):
    return [{"id": str(i), f"{domain}_title": f"{generator}-{i}",
             "text": f"{domain}-{generator}-{i}" + "完整的中文正文解释具体原因和事实。" * (15 if i == 0 else 60)}
            for i in range(count)]


def pools():
    return {(d, g): prepare.candidates(rows(d, g), d, g) for d, g in prepare.SHA256}


def test_deterministic_coverage_first_balanced_and_complete(tmp_path):
    candidates = pools()
    for pool in candidates.values():
        assert pool[0]["coverage_qualified"] and not pool[-1]["coverage_qualified"]
    chosen = prepare.select(candidates, 4)
    assert len(chosen) == 16
    for domain in prepare.DOMAINS:
        assert [sum(r["domain"] == domain and r["generator"] == g for r in chosen)
                for g in ("human", *prepare.GENERATORS)] == [4, 2, 1, 1]
    prepare.write_corpus(tmp_path, chosen)
    before = (tmp_path / "manifest.jsonl").read_bytes()
    prepare.write_corpus(tmp_path, prepare.select(candidates, 4))
    assert before == (tmp_path / "manifest.jsonl").read_bytes()
    manifest = [json.loads(line) for line in before.decode().splitlines()]
    for record, original in zip(manifest, chosen):
        assert (tmp_path / record["file"]).read_bytes() == original["text"].encode()
        assert record["dataset_revision"] == prepare.REVISION
        assert record["training_overlap"] == "unknown"
        assert record["license"] == prepare.LICENSE_NOTE
        assert record["source_url"].startswith("https://raw.githubusercontent.com/")
        assert record["text_sha256"] == prepare.digest(original["text"])
        assert "text" not in record


def test_reduces_count_instead_of_selecting_low_coverage():
    candidates = pools()
    chosen = prepare.select(candidates, 8)
    assert not any(not r["coverage_qualified"] for r in chosen)
    assert sum(r["label"] == "human" for r in chosen) == 14


@pytest.mark.parametrize("field", ["id", "text_sha256", "original_id"])
def test_exclusions_remove_ids_hashes_and_original_groups(field):
    candidates = pools()
    item = candidates["paper", "human"][0]
    exclusions = {"groups": set(), "hashes": set(), "ids": set()}
    if field == "original_id":
        exclusions["groups"].add(("paper", item[field]))
    else:
        exclusions["ids" if field == "id" else "hashes"].add(item[field])
    chosen = prepare.select(prepare.exclude(candidates, exclusions), 4)
    assert not any(r["id"] == item["id"] for r in chosen)
    if field == "original_id":
        assert not any(r["domain"] == "paper" and r["original_id"] == item["original_id"] for r in chosen)


def test_duplicate_texts_and_title_groups_are_not_selected_twice():
    candidates = pools()
    duplicate = dict(candidates["composition", "human"][0], id="duplicate")
    candidates["composition", "human"].insert(0, duplicate)
    chosen = prepare.select(candidates, 4)
    assert len({r["text_sha256"] for r in chosen}) == len(chosen)


def test_empty_and_insufficient_pools_fail():
    assert prepare.candidates([], "paper", "human") == []
    candidates = pools()
    candidates["paper", "human"] = []
    with pytest.raises(ValueError, match="Insufficient"):
        prepare.select(candidates, 4)
    with pytest.raises(ValueError, match="at least 3"):
        prepare.select(candidates, 0)


def test_exclusion_file_and_invalid_formats(tmp_path):
    path = tmp_path / "exclude.json"
    path.write_text('["cred-paper-human-1", "sha"]')
    assert prepare.load_exclusions(path)["ids"] == {"cred-paper-human-1", "sha"}
    path.write_text('{}')
    with pytest.raises(ValueError, match="JSON array"):
        prepare.load_exclusions(path)


def test_default_exclusions_are_pinned_and_text_free():
    exclusions = prepare.load_exclusions(prepare.DEFAULT_EXCLUSIONS)
    assert len(exclusions["groups"]) == 720
    assert len(exclusions["hashes"]) == 1440


def test_csv_exclusion_original_id_covers_other_generators(tmp_path):
    path = tmp_path / "exclusions.csv"
    path.write_text("genre,original_id,input_sha256,dataset_revision\npaper,1,hash," + prepare.REVISION + "\n")
    exclusions = prepare.load_exclusions(path)
    remaining = prepare.exclude(pools(), exclusions)
    assert all(r["original_id"] != "1" for (d, g), rows in remaining.items() if d == "paper" for r in rows)


def test_main_stops_and_reports_small_remaining_cells(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare, "PRIVATE_ROOT", tmp_path)
    monkeypatch.setattr(prepare, "fetch_source", lambda *args: tmp_path / "source.csv")
    (tmp_path / "source.csv").write_text("id,text,paper_title,composition_title\n")
    monkeypatch.setattr("sys.argv", [str(SCRIPT), "--out", str(tmp_path / "output")])
    with pytest.raises(ValueError, match='Fewer than 20.*composition:ai.*paper:human'):
        prepare.main()
    assert not (tmp_path / "output" / "manifest.jsonl").exists()


def test_download_and_cached_checksums(tmp_path, monkeypatch):
    data = b"id,text\n1,sample\n"
    monkeypatch.setitem(prepare.SHA256, ("paper", "human"), prepare.digest(data))
    monkeypatch.setattr(prepare.urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(data))
    path = prepare.fetch_source(tmp_path, "paper", "human")
    assert path.read_bytes() == data
    monkeypatch.setattr(prepare.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("cache should be verified offline"))
    assert prepare.fetch_source(tmp_path, "paper", "human") == path
    path.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="Cached source checksum mismatch"):
        prepare.fetch_source(tmp_path, "paper", "human")


def test_bad_download_is_not_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare.urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(b"corrupt"))
    with pytest.raises(ValueError, match="Downloaded source checksum mismatch"):
        prepare.fetch_source(tmp_path, "paper", "human")
    assert not list((tmp_path / "raw").iterdir())


def test_output_must_stay_private(monkeypatch, tmp_path):
    monkeypatch.setattr("sys.argv", [str(SCRIPT), "--out", str(tmp_path)])
    with pytest.raises(SystemExit) as error:
        prepare.main()
    assert error.value.code == 2
