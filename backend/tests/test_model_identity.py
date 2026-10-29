"""Bind evaluated thresholds to the bytes and recipe actually used for inference."""

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
