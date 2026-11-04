"""Bind evaluated thresholds to the bytes and recipe actually used for inference."""

import json
from pathlib import Path

import pytest

from app import model_identity


def test_missing_local_weights_have_no_revision(tmp_path: Path):
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    assert model_identity.model_revision(tmp_path, "pytorch") is None
    assert model_identity.model_revision(tmp_path, "onnx-int8") is None


@pytest.mark.parametrize(
    "filename",
    [
        "model.safetensors",
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "vocab.txt",
        "special_tokens_map.json",
        "vocab.json",
        "merges.txt",
        "tokenizer.model",
    ],
)
def test_weight_and_tokenizer_changes_invalidate_revision(tmp_path: Path, filename: str):
    (tmp_path / "model.safetensors").write_bytes(b"synthetic weights")
    target = tmp_path / filename
    target.write_bytes(b"initial fixture bytes")
    before = model_identity.model_revision(tmp_path, "pytorch")
    assert before == model_identity.model_revision(tmp_path, "pytorch")
    assert before.startswith("sha256:")
    target.write_bytes(b"changed fixture bytes")
    assert model_identity.model_revision(tmp_path, "pytorch") != before


def test_inference_recipe_version_invalidates_revision(tmp_path: Path, monkeypatch):
    (tmp_path / "model.safetensors").write_bytes(b"synthetic weights")
    before = model_identity.model_revision(tmp_path, "pytorch")
    monkeypatch.setattr(model_identity, "SCORING_VERSION", "changed-packing-and-aggregation")
    assert model_identity.model_revision(tmp_path, "pytorch") != before


def test_selected_runtime_and_precision_have_distinct_revisions(tmp_path: Path):
    for filename in ("model.safetensors", "model.onnx", "model.int8.onnx"):
        (tmp_path / filename).write_bytes(b"same synthetic byte fixture")
    revisions = {
        model_identity.model_revision(tmp_path, runtime)
        for runtime in ("pytorch", "onnx", "onnx-int8")
    }
    assert len(revisions) == 3
    assert None not in revisions


def test_onnx_external_tensor_data_invalidates_revision(tmp_path: Path):
    (tmp_path / "model.onnx").write_bytes(b"synthetic graph")
    external = tmp_path / "model.onnx_data"
    external.write_bytes(b"initial tensor bytes")
    before = model_identity.model_revision(tmp_path, "onnx")
    external.write_bytes(b"changed tensor bytes")
    assert model_identity.model_revision(tmp_path, "onnx") != before


def test_pytorch_bin_fallback_is_hashed(tmp_path: Path):
    weights = tmp_path / "pytorch_model.bin"
    weights.write_bytes(b"first fallback weights")
    before = model_identity.model_revision(tmp_path, "pytorch")
    assert before is not None
    weights.write_bytes(b"changed fallback weights")
    assert model_identity.model_revision(tmp_path, "pytorch") != before


def _versions(monkeypatch, **versions):
    def fake(package):
        if package not in versions:
            raise model_identity.metadata.PackageNotFoundError(package)
        return versions[package]

    monkeypatch.setattr(model_identity.metadata, "version", fake)


def test_library_minor_version_changes_invalidate_revision_but_patches_do_not(
    tmp_path: Path, monkeypatch
):
    (tmp_path / "model.safetensors").write_bytes(b"synthetic weights")
    _versions(monkeypatch, torch="2.9.0+cpu", transformers="4.57.1", tokenizers="0.22.0")
    before = model_identity.model_revision(tmp_path, "pytorch")
    _versions(monkeypatch, torch="2.9.1", transformers="4.57.3", tokenizers="0.22.1")
    assert model_identity.model_revision(tmp_path, "pytorch") == before
    _versions(monkeypatch, torch="2.9.0", transformers="4.58.0", tokenizers="0.22.0")
    assert model_identity.model_revision(tmp_path, "pytorch") != before


def test_inference_stack_names_the_runtime_libraries(monkeypatch):
    _versions(monkeypatch, torch="2.9.0+cpu", transformers="4.57.1", tokenizers="0.22.0")
    assert model_identity.inference_stack("pytorch") == {
        "torch": "2.9",
        "transformers": "4.57",
        "tokenizers": "0.22",
    }
    # onnxruntime 没装时写 none，而不是悄悄省略
    assert model_identity.inference_stack("onnx-int8") == {
        "onnxruntime": "none",
        "transformers": "4.57",
        "tokenizers": "0.22",
    }


def _sharded(
    tmp_path: Path, shards=("model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors")
):
    for name in shards:
        (tmp_path / name).write_bytes(name.encode())
    index = {"weight_map": {f"layer{i}": name for i, name in enumerate(shards)}}
    (tmp_path / "model.safetensors.index.json").write_text(json.dumps(index), encoding="utf-8")


def test_sharded_weights_get_a_revision_that_covers_every_shard(tmp_path: Path):
    _sharded(tmp_path)
    before = model_identity.model_revision(tmp_path, "pytorch")
    assert before and before.startswith("sha256:")
    (tmp_path / "model-00002-of-00002.safetensors").write_bytes(b"changed shard")
    assert model_identity.model_revision(tmp_path, "pytorch") != before


def test_sharded_weights_with_a_missing_shard_or_bad_index_have_no_revision(tmp_path: Path):
    _sharded(tmp_path)
    (tmp_path / "model-00002-of-00002.safetensors").unlink()
    assert model_identity.model_revision(tmp_path, "pytorch") is None
    (tmp_path / "model.safetensors.index.json").write_text("not json", encoding="utf-8")
    assert model_identity.model_revision(tmp_path, "pytorch") is None


def test_status_lists_the_inference_stack_per_language():
    from app.loader import ModelHub

    stack = ModelHub().status()["inference_stack"]
    assert set(stack) == {"zh", "en"}
    assert {"transformers", "tokenizers", "torch"} == set(stack["en"])


def test_shard_names_must_stay_inside_the_model_folder(tmp_path: Path):
    model = tmp_path / "model"
    model.mkdir()
    (tmp_path / "outside.safetensors").write_bytes(b"not part of the model")
    index = {"weight_map": {"layer0": "../outside.safetensors"}}
    (model / "model.safetensors.index.json").write_text(json.dumps(index), encoding="utf-8")
    assert model_identity.model_revision(model, "pytorch") is None
