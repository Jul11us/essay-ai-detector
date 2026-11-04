"""Bind calibration to the actual local weights, tokenizer and inference recipe."""

from __future__ import annotations

import hashlib
import json
import re
from importlib import metadata
from pathlib import Path

# Bump this when raw paragraph scoring, packing or document aggregation changes.
SCORING_VERSION = "paragraph-weighted-v1"

# The library code is part of the recipe too: the same weights can score differently under
# another transformers/tokenizers/torch (or onnxruntime) release, and requirements.txt only gives
# lower bounds. Major.minor is included; patch releases are not, so routine fixes do not void a
# calibration. Any change here makes an existing calibration fall back to the default thresholds.
STACK_PACKAGES = {
    "pytorch": ("torch", "transformers", "tokenizers"),
    "onnx": ("onnxruntime", "transformers", "tokenizers"),
}

TOKENIZER_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "tokenizer.model",
    "spiece.model",
    "sentencepiece.bpe.model",
)


def _major_minor(version: str) -> str:
    match = re.match(r"(\d+)\.(\d+)", version)
    return f"{match.group(1)}.{match.group(2)}" if match else version


def inference_stack(runtime: str) -> dict[str, str]:
    """Installed major.minor version of each library that takes part in scoring."""
    family = "onnx" if runtime.startswith("onnx") else "pytorch"
    versions = {}
    for package in STACK_PACKAGES[family]:
        try:
            versions[package] = _major_minor(metadata.version(package))
        except metadata.PackageNotFoundError:
            versions[package] = "none"
    return versions


def _weight_files(path: Path, runtime: str) -> list[Path]:
    """The weight files the loader will read, or [] when they are not all there."""
    if runtime.startswith("onnx"):
        weights = path / ("model.int8.onnx" if runtime == "onnx-int8" else "model.onnx")
        return [weights] if weights.is_file() else []
    for name in ("model.safetensors", "pytorch_model.bin"):
        if (path / name).is_file():
            return [path / name]
    # Sharded checkpoints: an index file maps tensors to shard files; every shard counts.
    for index_name in ("model.safetensors.index.json", "pytorch_model.bin.index.json"):
        index = path / index_name
        if not index.is_file():
            continue
        try:
            shards = sorted(
                set(json.loads(index.read_text(encoding="utf-8"))["weight_map"].values())
            )
        except (ValueError, KeyError, TypeError, AttributeError):
            return []
        files = [path / name for name in shards]
        root = path.resolve()
        if not files or not all(
            item.resolve().is_relative_to(root) and item.is_file() for item in files
        ):
            return []
        return [index, *files]
    return []


def model_revision(path: Path, runtime: str) -> str | None:
    weights = _weight_files(path, runtime)
    if not weights:
        return None
    stack = ";".join(f"{k}={v}" for k, v in sorted(inference_stack(runtime).items()))
    digest = hashlib.sha256(f"{runtime}:{SCORING_VERSION}:{stack}".encode())
    files = weights + [path / name for name in TOKENIZER_FILES if (path / name).is_file()]
    if runtime.startswith("onnx"):
        files.extend(
            sorted(
                {
                    item
                    for pattern in (weights[0].name + "*", "*.data")
                    for item in path.glob(pattern)
                    if item.is_file() and item not in files
                }
            )
        )
    for item in files:
        digest.update(item.name.encode())
        with item.open("rb") as stream:
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
    return "sha256:" + digest.hexdigest()
