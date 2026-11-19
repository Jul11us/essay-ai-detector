from __future__ import annotations

import hashlib
from pathlib import Path

MODEL_IDS = {
    "zh": "yuchuantian/AIGC_detector_zhv3",
    "en": "ShantanuT01/vanguard-ai-text-detector",
}
MODEL_COMMITS = {
    "zh": "47695ff451b32c225dd938f4f478f7fdc6aa6bb0",
    "en": "823061be63b90f2b42f64ac1e1f82772e872533b",
}
MODEL_SHA256 = {
    "zh": {
        "config.json": "74dfcf54a25f4847f97e285f60c03d3ceaccba87484c41ab4144e6acc4d7ecf4",
        "tokenizer_config.json": "988cf0a4f56217ba915002e24de6d4621188f16942e5768d4eaf6564b166e1f0",
        "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
        "vocab.txt": "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c",
        "pytorch_model.bin": "83b065f6302b98d296cdcad6e8f944013faa3cdc89de3d72aca5ecc8e0eaaded",
    },
    "en": {
        "config.json": "51f68315441348d6ed8b827f83c49ffcbdb4cb6b79257dbcb9e2a91b4ad7d296",
        "tokenizer.json": "707714619968e91e73cce14af61ce93d1cacf7e1ed834a4c6f6a702c65796eaf",
        "tokenizer_config.json": "2966a59b9e9cf122279aec1249e22e5bc7ad8430c754e95031b13fd128d4e560",
        "special_tokens_map.json": "ea97ecdbcc73713039d8d64dbb05e3689495c96657fbd9a18f5bed381be81049",
        "model.safetensors": "dd671ad2d64319210ba6a41b32275bd84e81c696b3dfba488833edcf24861c22",
    },
}


def matches_sha256(path: Path, expected: str) -> bool:
    if not path.is_file():
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == expected


def verify_artifacts(path: Path, lang: str) -> None:
    for name in ("tokenizer.json", "added_tokens.json"):
        if name not in MODEL_SHA256[lang] and (path / name).is_file():
            raise RuntimeError(f"模型目录含非锁定分词文件：{name}")
    for name, expected in MODEL_SHA256[lang].items():
        if not matches_sha256(path / name, expected):
            raise RuntimeError(f"模型文件缺失或校验失败：{name}（版本 {MODEL_COMMITS[lang][:12]}）")
