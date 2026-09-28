"""可选的 ONNX 推理。没有导出文件、或显式关掉时，调用方继续用 PyTorch。"""

from __future__ import annotations

import os
from pathlib import Path


def preferred_onnx(model_dir: Path) -> Path | None:
    """INT8 优先。`DETECTOR_ONNX=0` 时即使文件在也不用。"""
    if os.environ.get("DETECTOR_ONNX", "1") == "0":
        return None
    for name in ("model.int8.onnx", "model.onnx"):
        path = model_dir / name
        if path.is_file():
            return path
    return None


class OnnxClassifier:
    """给 `score_paragraph` 用的薄封装：它只需要 `parameters()` 和带 `.logits` 的调用结果。"""

    def __init__(self, path: Path) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.path = path
        self.runtime = "onnx-int8" if "int8" in path.name else "onnx"
        self.session = ort.InferenceSession(
            str(path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        self._input_names = {item.name for item in self.session.get_inputs()}

    def parameters(self):
        import torch

        yield torch.zeros(1)

    def __call__(self, **kwargs):
        import numpy as np
        import torch

        feeds = {}
        for key, value in kwargs.items():
            if key not in self._input_names:
                continue
            if hasattr(value, "detach"):
                value = value.detach().cpu().numpy()
            feeds[key] = np.ascontiguousarray(value)
        logits = self.session.run(None, feeds)[0]
        return _Logits(torch.from_numpy(np.asarray(logits)))


class _Logits:
    def __init__(self, logits) -> None:
        self.logits = logits
