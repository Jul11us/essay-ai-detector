"""Manifest builder for private essay folders."""

import importlib.util
import json
from pathlib import Path

import pytest

from benchmark import load_manifest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "build_manifest.py"
_SPEC = importlib.util.spec_from_file_location("build_manifest", _SCRIPT)
builder = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(builder)


def _folder(tmp_path, files):
    for name, text in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return tmp_path


def _meta(**rows):
    return [{"source": "class submissions", **row} for row in rows.values()]


def test_builds_rows_with_hashes_shared_group_split_and_optional_fields(tmp_path):
    folder = _folder(
        tmp_path,
        {
            "essays/0001-human.txt": "human text",
            "essays/0001-ai.txt": "ai text",
            "x/a.txt": "other",
        },
    )
    metadata = _meta(
        a={
            "file": "essays/0001-human.txt",
            "lang": "en",
            "label": "human",
            "group_id": "0001",
            "license": "written consent",
            "writer_group": "non_native",
        },
        b={
            "file": "essays/0001-ai.txt",
            "lang": "en",
            "label": "ai",
            "group_id": "0001",
            "generated_model": "some-model",
        },
        c={"file": "x/a.txt", "lang": "zh", "label": "human", "split": "test"},
    )
    rows = builder.build_rows(folder, metadata, seed="s", calibration_share=0.5)
    by_id = {r["id"]: r for r in rows}
    assert set(by_id) == {"essays-0001-human", "essays-0001-ai", "x-a"}
    assert by_id["essays-0001-human"]["split"] == by_id["essays-0001-ai"]["split"]
    assert by_id["x-a"]["split"] == "test" and by_id["x-a"]["group_id"] == "x-a"
    assert by_id["essays-0001-human"]["writer_group"] == "non_native"
    assert by_id["essays-0001-ai"]["generated_model"] == "some-model"
    assert all(r["training_overlap"] == "unknown" and len(r["text_sha256"]) == 64 for r in rows)
    manifest = folder / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    assert len(load_manifest(manifest)) == 3  # the evaluation run accepts it


def test_split_assignment_is_per_group_deterministic_and_uses_both_splits():
    splits = [builder.assign_split(f"group-{i}", "seed", 0.5) for i in range(200)]
    assert splits == [builder.assign_split(f"group-{i}", "seed", 0.5) for i in range(200)]
    share = splits.count("calibration") / len(splits)
    assert 0.35 < share < 0.65


@pytest.mark.parametrize(
    ("row", "message"),
    [
        ({"file": "a.txt", "lang": "en", "label": "human", "source": ""}, "missing source"),
        ({"file": "a.txt", "lang": "fr", "label": "human"}, "lang must be"),
        ({"file": "a.txt", "lang": "en", "label": "maybe"}, "label must be"),
        ({"file": "../outside.txt", "lang": "en", "label": "human"}, "not found inside"),
        ({"file": "a.txt", "lang": "en", "label": "human", "split": "train"}, "split must be"),
        (
            {"file": "a.txt", "lang": "en", "label": "human", "training_overlap": "excluded"},
            "needs training_overlap_evidence",
        ),
    ],
)
def test_rejects_bad_rows(tmp_path, row, message):
    (tmp_path / "a.txt").write_text("text", encoding="utf-8")
    (tmp_path.parent / "outside.txt").write_text("text", encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        builder.build_rows(tmp_path, [{"source": "s", **row}], "s", 0.5)


def test_rejects_duplicate_content_and_a_group_split_across_calibration_and_test(tmp_path):
    folder = _folder(tmp_path, {"a.txt": "same", "b.txt": "same", "c.txt": "c", "d.txt": "d"})
    with pytest.raises(ValueError, match="same content as a.txt"):
        builder.build_rows(
            folder,
            _meta(
                a={"file": "a.txt", "lang": "en", "label": "human"},
                b={"file": "b.txt", "lang": "en", "label": "ai"},
            ),
            "s",
            0.5,
        )
    with pytest.raises(ValueError, match="both calibration and test"):
        builder.build_rows(
            folder,
            _meta(
                c={
                    "file": "c.txt",
                    "lang": "en",
                    "label": "human",
                    "group_id": "g",
                    "split": "calibration",
                },
                d={"file": "d.txt", "lang": "en", "label": "ai", "group_id": "g", "split": "test"},
            ),
            "s",
            0.5,
        )


def test_cli_refuses_a_folder_outside_the_ignored_private_directory(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.argv", ["build_manifest.py", str(tmp_path)])
    with pytest.raises(SystemExit) as stop:
        builder.main()
    assert stop.value.code == 2
