from pathlib import Path

from app.ort_model import preferred_onnx


def test_int8_file_wins(tmp_path: Path):
    (tmp_path / "model.onnx").write_bytes(b"raw")
    (tmp_path / "model.int8.onnx").write_bytes(b"q")
    assert preferred_onnx(tmp_path).name == "model.int8.onnx"


def test_plain_onnx_is_used_when_int8_is_absent(tmp_path: Path):
    (tmp_path / "model.onnx").write_bytes(b"raw")
    assert preferred_onnx(tmp_path).name == "model.onnx"


def test_missing_file_is_none(tmp_path: Path):
    assert preferred_onnx(tmp_path) is None


def test_env_switch_disables_onnx(tmp_path: Path, monkeypatch):
    (tmp_path / "model.int8.onnx").write_bytes(b"q")
    monkeypatch.setenv("DETECTOR_ONNX", "0")
    assert preferred_onnx(tmp_path) is None
