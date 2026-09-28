"""把本机检测模型导出成 ONNX，并做 INT8 动态量化。

检测服务默认仍用 PyTorch。只有当模型目录里出现 `model.int8.onnx`
（且当前是 CPU、环境变量 DETECTOR_ONNX 不是 0）时，loader 才会改走 ONNX Runtime。

用法（在项目根目录，已激活装了 torch / transformers 的环境）：

    pip install -r backend/requirements-onnx.txt
    python experiments/export_onnx.py

英文默认读 `experiments/models/vanguard`，也可用 VANGUARD_MODEL_PATH。
中文默认读 ZH_MODEL_PATH；没设就跳过中文，不在这里重新下载。

ModernBERT 的自定义注意力有时导不出去。脚本失败时不会删掉原来的 PyTorch 权重，
服务继续用原来的路径。量化前后分数可能有很小的漂移，导出后应用黄金样本对一下。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def _export(model, tokenizer, dest: Path) -> None:
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic

    dest.mkdir(parents=True, exist_ok=True)
    raw = dest / "model.onnx"
    quantized = dest / "model.int8.onnx"
    sample = tokenizer("export probe", return_tensors="pt", truncation=True, max_length=32)
    input_names = []
    args = []
    dynamic = {}
    for name in ("input_ids", "attention_mask", "token_type_ids"):
        if name not in sample:
            continue
        input_names.append(name)
        args.append(sample[name])
        dynamic[name] = {0: "batch", 1: "seq"}
    model.eval()
    torch.onnx.export(
        model,
        tuple(args),
        str(raw),
        input_names=input_names,
        output_names=["logits"],
        dynamic_axes={**dynamic, "logits": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    quantize_dynamic(str(raw), str(quantized), weight_type=QuantType.QInt8)
    print(f"wrote {quantized}")


def export_vanguard() -> None:
    from app.loader import default_vanguard_path
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    path = default_vanguard_path()
    if not (path / "config.json").is_file():
        raise SystemExit(f"找不到英文权重：{path}")
    tok = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        str(path),
        local_files_only=True,
        attn_implementation="eager",
    )
    _export(model, tok, path)


def export_zh() -> None:
    override = os.environ.get("ZH_MODEL_PATH")
    if not override:
        print("没设 ZH_MODEL_PATH，跳过中文。")
        return
    path = Path(override)
    if not (path / "config.json").is_file():
        raise SystemExit(f"找不到中文权重：{path}")
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(str(path))
    model = AutoModelForSequenceClassification.from_pretrained(
        str(path),
        num_labels=2,
        id2label={0: "人类", 1: "AI"},
        label2id={"人类": 0, "AI": 1},
    )
    _export(model, tok, path)


def main() -> None:
    export_vanguard()
    export_zh()


if __name__ == "__main__":
    main()
