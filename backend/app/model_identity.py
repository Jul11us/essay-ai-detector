"""Bind calibration to the actual local weights, tokenizer and inference recipe."""
from __future__ import annotations

import hashlib
from pathlib import Path

# Bump this when raw paragraph scoring, packing or document aggregation changes.
SCORING_VERSION = "paragraph-weighted-v1"


def model_revision(path: Path, runtime: str) -> str | None:
    if runtime.startswith("onnx"):
        weights = path / ("model.int8.onnx" if runtime == "onnx-int8" else "model.onnx")
    else:
        weights = path / "model.safetensors"
        if not weights.is_file():
            weights = path / "pytorch_model.bin"
    if not weights.is_file():
        return None
    digest = hashlib.sha256(f"{runtime}:{SCORING_VERSION}".encode())
    files = [weights] + [path / name for name in (
        "config.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt", "special_tokens_map.json",
        "vocab.json", "merges.txt", "tokenizer.model", "spiece.model", "sentencepiece.bpe.model",
    ) if (path / name).is_file()]
    if runtime.startswith("onnx"):
        files.extend(sorted({item for pattern in (weights.name + "*", "*.data")
                             for item in path.glob(pattern) if item.is_file() and item not in files}))
    for item in files:
        digest.update(item.name.encode())
        with item.open("rb") as stream:
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
    return "sha256:" + digest.hexdigest()
