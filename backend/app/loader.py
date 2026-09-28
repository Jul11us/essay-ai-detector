from __future__ import annotations

import os
import threading
from pathlib import Path

from app.errors import DetectError
from app.sanity import check_zh_direction
from app.scoring import (
    EN_INFER_STRIDE,
    EN_INFER_TOKENS,
    HEAD_SIGMOID,
    HEAD_SOFTMAX,
    MODEL_IDS,
    resolve_ai_index,
    score_paragraph,
    score_short_texts,
)

HF_MIRROR = "https://hf-mirror.com"

LANG_NAMES = {"zh": "中文", "en": "英文"}


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_vanguard_path() -> Path:
    override = os.environ.get("VANGUARD_MODEL_PATH")
    if override:
        return Path(override)
    return project_root() / "experiments" / "models" / "vanguard"


def assert_clean_loading(loading: dict) -> None:
    """权重和模型结构必须完全对上。

    以前只有 Vanguard 这条路径核对，中文路径没有：将来换个标签数不同的模型，
    `from_pretrained` 会静默随机初始化分类头，输出全是噪声而且不报错。
    两条路径现在用同一套校验。
    """
    missing = loading.get("missing_keys") or []
    unexpected = loading.get("unexpected_keys") or []
    mismatched = loading.get("mismatched_keys") or []
    if missing or unexpected or mismatched:
        raise RuntimeError(
            "权重与模型结构不匹配："
            f"missing={len(missing)} unexpected={len(unexpected)} mismatched={len(mismatched)}"
        )



class ModelHub:
    def __init__(self) -> None:
        self.phase = "downloading"
        self.detail = "正在准备模型…"
        self.loaded = {"zh": False, "en": False}
        self._lock = threading.Lock()
        self._models: dict = {}
        self._tokenizers: dict = {}
        self._heads: dict[str, str] = {}
        self._ai_index: dict[str, int | None] = {}
        self._max_length: dict[str, int] = {}
        self._stride: dict[str, int] = {}
        self._label_check: dict[str, dict] = {}
        self._errors: dict[str, str] = {}
        self._runtimes = {"zh": "pytorch", "en": "pytorch"}
        self._thread: threading.Thread | None = None

    def status(self) -> dict:
        return {
            "phase": self.phase,
            "detail": self.detail,
            "models": dict(self.loaded),
            # 让人能从接口看出实际用的是哪种头、AI 类是哪个下标，
            # 而不是只能靠读 loader 源码猜。
            "heads": {
                lang: {
                    "kind": self._heads.get(lang),
                    "ai_index": self._ai_index.get(lang),
                }
                for lang in ("zh", "en")
            },
            "label_check": dict(self._label_check),
            # 加载线程是否还在跑。前端靠它决定还要不要每 2 秒问一次：
            # `phase` 在英文就绪后就变 ready，光看 `models` 分不清中文是
            # 「还在下」还是「失败了」，只能去嗅 detail 文案——那正是要避免的。
            "loading": self._thread is not None and self._thread.is_alive(),
            "runtime": dict(self._runtimes),
        }

    def assert_ready(self, lang: str | None = None) -> None:
        if lang == "bi":
            if not (self.loaded.get("zh") and self.loaded.get("en")):
                raise DetectError("models_not_ready")
            return
        if lang in {"zh", "en"}:
            if not self.loaded.get(lang):
                raise DetectError("models_not_ready")
            return
        if not any(self.loaded.values()):
            raise DetectError("models_not_ready")

    def load_in_background(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._load_all, daemon=True)
        self._thread.start()

    def _sync_phase(self) -> None:
        """按已加载的语言和显式记录的失败原因推导 phase / detail。

        以前靠 `"失败" in self.detail` 嗅探，很脆；也不能把「还没加载」说成
        「未加载」，否则英文刚就绪、中文正在下载时会谎报失败原因。
        """
        en, zh = self.loaded["en"], self.loaded["zh"]
        if en and zh:
            self.phase, self.detail = "ready", "中英文模型均已就绪"
            return
        if not en and not zh:
            reason = self._errors.get("en") or self._errors.get("zh")
            if reason:
                self.phase, self.detail = "error", f"模型下载或加载失败：{reason}"
            else:
                self.phase, self.detail = "downloading", "正在准备模型…"
            return
        ready_lang, pending_lang = ("en", "zh") if en else ("zh", "en")
        reason = self._errors.get(pending_lang)
        if reason:
            detail = f"{LANG_NAMES[ready_lang]}已就绪；{LANG_NAMES[pending_lang]}未加载：{reason}"
        else:
            detail = f"{LANG_NAMES[ready_lang]}已就绪；正在准备{LANG_NAMES[pending_lang]}模型…"
        self.phase, self.detail = "ready", detail

    def _load_all(self) -> None:
        try:
            self.detail = "正在加载本地 Vanguard 英文模型…"
            self._load_vanguard()
            self.loaded["en"] = True
        except Exception as exc:
            self._errors["en"] = str(exc)
        self._sync_phase()

        try:
            self.detail = "正在准备中文模型…"
            path = self._download_zh()
            self._load_softmax("zh", path, max_length=512, stride=256)
            self.detail = "正在核对中文分类头方向…"
            self._label_check["zh"] = check_zh_direction(lambda s: self._forward(s, "zh"))
            self.loaded["zh"] = True
        except Exception as exc:
            self._errors["zh"] = str(exc)
        self._sync_phase()

    def _load_vanguard(self) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        path = default_vanguard_path()
        if not path.is_dir() or not (path / "config.json").exists():
            raise FileNotFoundError(f"Vanguard weights not found: {path}")
        tok = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
        onnx_model = self._maybe_onnx(path)
        if onnx_model is not None:
            model = onnx_model
            self._runtimes["en"] = onnx_model.runtime
        else:
            model, loading = AutoModelForSequenceClassification.from_pretrained(
                str(path),
                local_files_only=True,
                attn_implementation="eager",
                reference_compile=False,
                output_loading_info=True,
            )
            assert_clean_loading(loading)
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            model.to(device)
            model.eval()
            self._runtimes["en"] = "pytorch"
        self._tokenizers["en"] = tok
        self._models["en"] = model
        self._heads["en"] = HEAD_SIGMOID
        self._ai_index["en"] = None
        # 不用 config.max_position_embeddings（8192）：分段器把英文单元限制在
        # 1200 字符以内，这个流水线到不了 8192，按它配置等于假装用满长上下文。
        self._max_length["en"] = EN_INFER_TOKENS
        self._stride["en"] = EN_INFER_STRIDE

    def _download_zh(self) -> str:
        repo_id = MODEL_IDS["zh"]
        override = os.environ.get("ZH_MODEL_PATH")
        if override:
            path = Path(override)
            if path.is_dir() and (path / "config.json").exists():
                return str(path)
        from huggingface_hub import snapshot_download

        attempts: list[str] = []
        for label, kwargs in (
            ("本地缓存", {"local_files_only": True}),
            ("Hugging Face", {}),
            ("hf-mirror", {"endpoint": HF_MIRROR}),
        ):
            try:
                return snapshot_download(repo_id=repo_id, **kwargs)
            except Exception as exc:
                attempts.append(f"{label}({type(exc).__name__})")

        try:
            from modelscope.hub.snapshot_download import snapshot_download as ms_download
        except ImportError as exc:
            raise RuntimeError(
                "中文模型下载失败：已尝试 " + "、".join(attempts)
                + "；ModelScope 兜底也不可用，因为当前环境没装 modelscope"
                "（pip install modelscope）。"
            ) from exc

        try:
            return ms_download(repo_id)
        except Exception:
            alt = "YuchuanTian/" + repo_id.split("/", 1)[-1]
            attempts.append(f"ModelScope({repo_id})")
            try:
                return ms_download(alt)
            except Exception as exc2:
                attempts.append(f"ModelScope({alt})")
                raise RuntimeError(
                    "中文模型下载失败：已尝试 " + "、".join(attempts) + "。"
                ) from exc2

    def _load_softmax(self, lang: str, path: str, max_length: int, stride: int) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        tok = AutoTokenizer.from_pretrained(path)
        extra = {}
        if lang == "zh":
            extra = {
                "num_labels": 2,
                "id2label": {0: "人类", 1: "AI"},
                "label2id": {"人类": 0, "AI": 1},
            }
        onnx_model = self._maybe_onnx(Path(path))
        if onnx_model is not None:
            from transformers import AutoConfig

            # ONNX 会话没有 config，分类头下标仍从权重目录的配置读。
            config = AutoConfig.from_pretrained(path, **extra)
            model = onnx_model
            ai_index = resolve_ai_index(config.id2label)
            self._runtimes[lang] = onnx_model.runtime
        else:
            model, loading = AutoModelForSequenceClassification.from_pretrained(
                path, output_loading_info=True, **extra
            )
            assert_clean_loading(loading)
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            model.to(device)
            model.eval()
            ai_index = resolve_ai_index(model.config.id2label)
            self._runtimes[lang] = "pytorch"
        self._tokenizers[lang] = tok
        self._models[lang] = model
        self._heads[lang] = HEAD_SOFTMAX
        self._ai_index[lang] = ai_index
        self._max_length[lang] = max_length
        self._stride[lang] = stride

    def _maybe_onnx(self, path: Path):
        """CPU 上如果旁边有导出的 ONNX，就用它。有显卡时仍走 PyTorch，避免改用 CPU ONNX。"""
        import sys

        import torch

        if torch.cuda.is_available() and os.environ.get("DETECTOR_ONNX_ON_GPU") != "1":
            return None
        from app.ort_model import OnnxClassifier, preferred_onnx

        onnx_path = preferred_onnx(path)
        if onnx_path is None:
            return None
        try:
            return OnnxClassifier(onnx_path)
        except Exception as exc:
            print(f"ONNX 加载失败，改用 PyTorch：{exc}", file=sys.stderr)
            return None

    def _forward(self, text: str, lang: str) -> float:
        return score_paragraph(
            text,
            self._tokenizers[lang],
            self._models[lang],
            head=self._heads[lang],
            ai_index=self._ai_index[lang],
            max_length=self._max_length[lang],
            stride=self._stride[lang],
        )

    def score(self, text: str, lang: str) -> float:
        self.assert_ready(lang)
        return self._forward(text, lang)

    def score_many(self, texts: list[str], lang: str) -> list[float]:
        """逐句打分用：一批短文本成批前向。没加载真实模型时（测试里）退回逐条 `score`。"""
        if lang not in self._models:
            return [self.score(t, lang) for t in texts]
        self.assert_ready(lang)
        return score_short_texts(
            texts,
            self._tokenizers[lang],
            self._models[lang],
            head=self._heads[lang],
            ai_index=self._ai_index[lang],
            max_length=self._max_length[lang],
        )
