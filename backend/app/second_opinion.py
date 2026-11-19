from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from app.model_artifacts import EN_REVIEW_MODEL_COMMIT, EN_REVIEW_MODEL_ID, verify_en_review_artifacts

REVIEW_THRESHOLD = 0.2915322184562683
logger = logging.getLogger(__name__)


def default_en_review_path() -> Path:
    override = os.environ.get("EN_REVIEW_MODEL_PATH")
    return Path(override) if override else Path(__file__).resolve().parents[2] / "experiments/models/openai-detector"


class EnglishSecondOpinion:
    def __init__(self) -> None:
        self.enabled = os.environ.get("DETECTOR_EN_REVIEW") == "1"
        self.state = "unavailable" if self.enabled else "disabled"
        self._model = None
        self._tokenizer = None
        self._thread: threading.Thread | None = None

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "state": self.state,
            "model_id": EN_REVIEW_MODEL_ID,
            "model_revision": EN_REVIEW_MODEL_COMMIT,
        }

    def load_in_background(self) -> None:
        if not self.enabled or (self._thread and self._thread.is_alive()):
            return
        self.state = "loading"
        self._thread = threading.Thread(target=self._load_safely, daemon=True)
        self._thread.start()

    def _load_safely(self) -> None:
        try:
            self._load()
            self.state = "ready"
        except Exception as exc:
            self._model = self._tokenizer = None
            self.state = "unavailable"
            logger.warning("英文复核模型不可用：%s", exc)

    def _load(self) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        from app.loader import assert_clean_loading

        path = default_en_review_path()
        verify_en_review_artifacts(path)
        tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
        model, loading = AutoModelForSequenceClassification.from_pretrained(
            str(path), local_files_only=True, use_safetensors=True,
            attn_implementation="eager", output_loading_info=True,
        )
        # 历史快照带 pooler；序列分类头只读取 sequence_output，不使用 pooler。
        unused = {"roberta.pooler.dense.bias", "roberta.pooler.dense.weight"}
        assert_clean_loading({**loading, "unexpected_keys": [key for key in loading.get("unexpected_keys", []) if key not in unused]})
        if model.config.id2label != {0: "Fake", 1: "Real"}:
            raise RuntimeError("英文复核模型标签与锁定配置不符")
        model.to(torch.device("cpu"))
        model.eval()
        self._tokenizer, self._model = tokenizer, model

    def score(self, text: str) -> float | None:
        if not self.enabled or self.state != "ready":
            return None
        import torch

        try:
            inputs = self._tokenizer(text, truncation=True, max_length=512, return_tensors="pt")
            with torch.inference_mode():
                return float(self._model(**inputs).logits.float().softmax(-1)[0, 0].item())
        except Exception as exc:
            self.state = "unavailable"
            logger.warning("英文复核推理失败：%s", exc)
            return None
