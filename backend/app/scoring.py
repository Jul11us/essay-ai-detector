from __future__ import annotations

import re

import torch
import torch.nn.functional as F

MODEL_IDS = {
    "zh": "yuchuantian/AIGC_detector_zhv3",
    "en": "ShantanuT01/vanguard-ai-text-detector",
}

HEAD_SIGMOID = "sigmoid"
HEAD_SOFTMAX = "softmax"

# 英文一次前向的 token 预算。
# 分段器保证英文单元不超过 paragraphs.SEGMENT_CHARS["en"] = 1200 个字符，
# 最坏情况 1 字符 = 1 token，即 ≤1200 token < 2048，所以任何英文单元都是一段一窗。
# Vanguard 的 8192 上下文在这条流水线里根本到不了；按 8192/4096 配置只会让人
# 以为用满了长上下文。真要吃满上下文，必须先把 SEGMENT_CHARS["en"] 一起调大。
EN_INFER_TOKENS = 2048
EN_INFER_STRIDE = EN_INFER_TOKENS // 2

_BATCH_CAP = 8
# 一批窗口的 Σ(seq_len²) 上限。eager attention 的分数矩阵是
# heads × seq² × 4 字节，固定 batch=8 配长窗能一次吃掉几十 GB。
_BATCH_SQ_BUDGET = 4_000_000


def batch_size_for(width: int) -> int:
    """按窗口宽度反推安全 batch，长窗自动退化成单条。"""
    if width <= 0:
        return _BATCH_CAP
    return max(1, min(_BATCH_CAP, _BATCH_SQ_BUDGET // (width * width)))

_AI_MARKERS = ("ai", "generated", "machine", "fake", "机器", "生成", "伪造")
_HUMAN_MARKERS = ("human", "real", "original", "人类", "真人", "人写")
_GENERIC_LABEL = re.compile(r"^label[_-]?\d+$", re.I)


def _has_marker(label: str, markers: tuple[str, ...]) -> bool:
    if _GENERIC_LABEL.match(label.strip()):
        return False
    lowered = label.lower()
    return any(m in lowered for m in markers)


def resolve_ai_index(id2label: dict) -> int:
    parsed: list[tuple[int, str]] = []
    for k, v in id2label.items():
        parsed.append((int(k), str(v)))
    ai = [i for i, lab in parsed if _has_marker(lab, _AI_MARKERS)]
    if len(ai) == 1:
        return ai[0]
    if len(parsed) == 2:
        human = [i for i, lab in parsed if _has_marker(lab, _HUMAN_MARKERS)]
        if len(human) == 1:
            other = [i for i, _ in parsed if i != human[0]]
            return other[0]
        if len(ai) == 0 and {idx for idx, _ in parsed} == {0, 1}:
            # zhv3 的 config 没有 id2label，官方口径是 0=人类、1=AI
            return 1
    raise RuntimeError("cannot resolve AI label")


def content_windows(n_tokens: int, budget: int, step: int) -> list[tuple[int, int]]:
    if n_tokens <= 0 or budget <= 0:
        return []
    if n_tokens <= budget:
        return [(0, n_tokens)]
    step = max(1, step)
    spans: list[tuple[int, int]] = []
    start = 0
    while start < n_tokens:
        end = min(start + budget, n_tokens)
        spans.append((start, end))
        if end == n_tokens:
            break
        start += step
    return spans


def _ai_prob(logits: torch.Tensor, head: str, ai_index: int | None) -> float:
    if head == HEAD_SIGMOID:
        flat = logits.reshape(-1)
        if flat.numel() != 1:
            raise ValueError(f"Expected single sigmoid logit, got {tuple(logits.shape)}")
        return float(torch.sigmoid(flat[0]).item())
    if logits.dim() == 3:
        logits = logits[:, 0, :]
    if ai_index is None:
        raise ValueError("softmax head requires ai_index")
    if logits.dim() == 1:
        logits = logits.unsqueeze(0)
    prob = F.softmax(logits.float(), dim=-1)[0, ai_index]
    return float(prob.item())


def _raw_token_ids(tokenizer, text: str) -> list[int]:
    if hasattr(tokenizer, "encode"):
        raw = tokenizer.encode(text, add_special_tokens=False)
        if hasattr(raw, "tolist"):
            raw = raw.tolist()
        return [int(x) for x in raw]
    enc = tokenizer(text, return_tensors="pt", truncation=False, add_special_tokens=False)
    return [int(x) for x in enc["input_ids"].reshape(-1).tolist()]


def _window_features(tokenizer, chunk: list[int], max_length: int) -> dict:
    if hasattr(tokenizer, "build_inputs_with_special_tokens"):
        ids = tokenizer.build_inputs_with_special_tokens(list(chunk))
    else:
        ids = list(chunk)
    if len(ids) > max_length:
        ids = ids[:max_length]
    feat: dict = {"input_ids": ids, "attention_mask": [1] * len(ids)}
    names = getattr(tokenizer, "model_input_names", [])
    if "token_type_ids" in names:
        feat["token_type_ids"] = [0] * len(ids)
    return feat


def score_paragraph(
    text: str,
    tokenizer,
    model,
    *,
    head: str,
    ai_index: int | None = None,
    max_length: int = 512,
    stride: int = 256,
) -> float:
    n_special = 0
    if hasattr(tokenizer, "num_special_tokens_to_add"):
        n_special = int(tokenizer.num_special_tokens_to_add(pair=False))
    budget = max(1, max_length - n_special)
    step = max(1, min(budget, stride))
    raw = _raw_token_ids(tokenizer, text)
    spans = content_windows(len(raw), budget, step)
    if not spans:
        return 0.0
    features = [_window_features(tokenizer, raw[a:b], max_length) for a, b in spans]
    if hasattr(tokenizer, "pad"):
        enc = tokenizer.pad(features, padding=True, return_tensors="pt")
    else:
        ids = torch.tensor([f["input_ids"] for f in features], dtype=torch.long)
        mask = torch.tensor([f["attention_mask"] for f in features], dtype=torch.long)
        enc = {"input_ids": ids, "attention_mask": mask}

    device = next(model.parameters()).device
    input_ids = enc["input_ids"]
    attention_mask = enc["attention_mask"]
    token_type_ids = enc.get("token_type_ids")
    weighted = 0.0
    total = 0
    batch_size = batch_size_for(int(input_ids.shape[1]))
    with torch.inference_mode():
        for i in range(0, int(input_ids.shape[0]), batch_size):
            b_ids = input_ids[i : i + batch_size].to(device)
            b_mask = attention_mask[i : i + batch_size].to(device)
            kwargs = {"input_ids": b_ids, "attention_mask": b_mask}
            if token_type_ids is not None:
                kwargs["token_type_ids"] = token_type_ids[i : i + batch_size].to(device)
            logits = model(**kwargs).logits
            for j in range(b_ids.shape[0]):
                w = int(b_mask[j].sum().item())
                prob = _ai_prob(logits[j : j + 1], head, ai_index)
                weighted += prob * w
                total += w
    if total == 0:
        return 0.0
    return weighted / total


# 短文本（单句、句子加上下文）一批最多这么多条。句子只有几十个 token，
# 注意力矩阵很小，可以比段落批大；真正的上限仍由 _BATCH_SQ_BUDGET 兜着。
_SHORT_BATCH_CAP = 16


def score_short_texts(
    texts: list[str],
    tokenizer,
    model,
    *,
    head: str,
    ai_index: int | None = None,
    max_length: int = 512,
) -> list[float]:
    """一批短文本各出一个 P(AI)。

    和 score_paragraph 的区别：每条只取一个窗口（超长就截断，句子不会超），
    多条按长度排序后成批前向，逐句打分时不必一句一次前向。
    """
    if not texts:
        return []
    n_special = 0
    if hasattr(tokenizer, "num_special_tokens_to_add"):
        n_special = int(tokenizer.num_special_tokens_to_add(pair=False))
    budget = max(1, max_length - n_special)
    features = [
        _window_features(tokenizer, _raw_token_ids(tokenizer, t)[:budget], max_length)
        for t in texts
    ]
    # 长度相近的放一批，少补 padding。
    order = sorted(range(len(texts)), key=lambda i: len(features[i]["input_ids"]))
    device = next(model.parameters()).device
    out = [0.0] * len(texts)
    start = 0
    with torch.inference_mode():
        while start < len(order):
            candidate = order[start : start + _SHORT_BATCH_CAP]
            width = len(features[candidate[-1]]["input_ids"])  # 已按长度排序，末条最宽
            size = max(1, min(len(candidate), _BATCH_SQ_BUDGET // max(1, width * width)))
            idx = candidate[:size]
            batch = [features[i] for i in idx]
            if hasattr(tokenizer, "pad"):
                enc = tokenizer.pad(batch, padding=True, return_tensors="pt")
            else:
                ids = torch.tensor([f["input_ids"] for f in batch], dtype=torch.long)
                mask = torch.tensor([f["attention_mask"] for f in batch], dtype=torch.long)
                enc = {"input_ids": ids, "attention_mask": mask}
            kwargs = {
                "input_ids": enc["input_ids"].to(device),
                "attention_mask": enc["attention_mask"].to(device),
            }
            if enc.get("token_type_ids") is not None:
                kwargs["token_type_ids"] = enc["token_type_ids"].to(device)
            logits = model(**kwargs).logits
            for j, i in enumerate(idx):
                out[i] = _ai_prob(logits[j : j + 1], head, ai_index)
            start += size
    return out
