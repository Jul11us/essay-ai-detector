import pytest
import math
from types import SimpleNamespace

import torch

from app.paragraphs import SEGMENT_CHARS
from app.scoring import (
    EN_INFER_STRIDE,
    EN_INFER_TOKENS,
    HEAD_SIGMOID,
    HEAD_SOFTMAX,
    batch_size_for,
    content_windows,
    resolve_ai_index,
    score_paragraph,
    score_short_texts,
)


def test_resolve_ai_from_generated_label():
    assert resolve_ai_index({0: "HUMAN", 1: "AI_GENERATED"}) == 1
    assert resolve_ai_index({"0": "human", "1": "machine"}) == 1
    assert resolve_ai_index({0: "LABEL_0", 1: "LABEL_1"}) == 1
    assert resolve_ai_index({"0": "人类", "1": "AI"}) == 1


def test_content_windows_single_and_strided():
    assert content_windows(10, budget=512, step=256) == [(0, 10)]
    spans = content_windows(600, budget=510, step=256)
    assert spans[0] == (0, 510)
    assert spans[-1][1] == 600
    assert all(b - a <= 510 for a, b in spans)


def test_english_segment_always_fits_one_window():
    """英文预算 2048 是按「最坏情况 1 字符 = 1 token」定的。

    这条锁住的是 SEGMENT_CHARS["en"] 与 EN_INFER_TOKENS 的耦合：
    谁把分段上限调大到超过 2048，这里就会红，而不是悄悄多切几个窗口。
    """
    worst_case = SEGMENT_CHARS["en"]
    assert worst_case < EN_INFER_TOKENS
    assert content_windows(
        worst_case, budget=EN_INFER_TOKENS - 2, step=EN_INFER_STRIDE
    ) == [(0, worst_case)]


def test_chinese_segments_do_use_strided_windows():
    """中文刻意相反：800 字超过 510 token 预算，必须走滑窗。"""
    spans = content_windows(SEGMENT_CHARS["zh"], budget=510, step=256)
    assert len(spans) > 1
    assert spans[0] == (0, 510)
    assert spans[-1][1] == SEGMENT_CHARS["zh"]


def test_batch_size_shrinks_on_long_windows():
    """eager attention 按 seq² 吃内存，长窗必须退化成单条。"""
    assert batch_size_for(0) == 8
    assert batch_size_for(300) == 8
    assert batch_size_for(EN_INFER_TOKENS) == 1
    assert batch_size_for(8192) == 1


def test_score_paragraph_batches_long_windows_one_at_a_time():
    """一整段超长文本切多窗时，批大小必须退到 1 而不是固定 8。"""
    model = FakeSoftmaxModel(0.3)
    score_paragraph(
        "long",
        FakeTok(6000),
        model,
        head=HEAD_SOFTMAX,
        ai_index=1,
        max_length=2048,
        stride=1024,
    )
    assert int(model.last_batch_ids.shape[0]) == 1


class FakeTok:
    def __init__(self, n: int):
        self.n = n
        self.model_input_names = ["input_ids", "attention_mask"]

    def encode(self, text, add_special_tokens=False):
        return [1] * self.n

    def num_special_tokens_to_add(self, pair=False):
        return 2

    def build_inputs_with_special_tokens(self, token_ids_0, token_ids_1=None):
        return [101] + list(token_ids_0) + [102]

    def pad(self, features, padding=True, return_tensors=None):
        ids = [list(f["input_ids"]) for f in features]
        max_len = max(len(x) for x in ids)
        padded = [x + [0] * (max_len - len(x)) for x in ids]
        mask = [[1] * len(x) + [0] * (max_len - len(x)) for x in ids]
        out = {
            "input_ids": torch.tensor(padded, dtype=torch.long),
            "attention_mask": torch.tensor(mask, dtype=torch.long),
        }
        return out


class FakeSoftmaxModel:
    def __init__(self, p_ai: float):
        self.p_ai = p_ai
        self.last_batch_ids = None

    def parameters(self):
        yield torch.nn.Parameter(torch.zeros(1))

    def __call__(self, **batch):
        self.last_batch_ids = batch["input_ids"]
        bsz = batch["input_ids"].shape[0]
        logit_ai = math.log(self.p_ai)
        logit_h = math.log(1 - self.p_ai)
        logits = torch.tensor([[logit_h, logit_ai]] * bsz, dtype=torch.float)
        return SimpleNamespace(logits=logits)


class FakeSigmoidModel:
    def __init__(self, p_ai: float):
        self.p_ai = p_ai

    def parameters(self):
        yield torch.nn.Parameter(torch.zeros(1))

    def __call__(self, **batch):
        bsz = batch["input_ids"].shape[0]
        logit = math.log(self.p_ai / (1 - self.p_ai))
        return SimpleNamespace(logits=torch.tensor([[logit]] * bsz, dtype=torch.float))


def test_score_paragraph_softmax():
    p = score_paragraph(
        "hello",
        FakeTok(8),
        FakeSoftmaxModel(0.25),
        head=HEAD_SOFTMAX,
        ai_index=1,
    )
    assert abs(p - 0.25) < 1e-5


def test_score_paragraph_vanguard_sigmoid():
    p = score_paragraph(
        "hello",
        FakeTok(8),
        FakeSigmoidModel(0.25),
        head=HEAD_SIGMOID,
        max_length=8192,
        stride=4096,
    )
    assert abs(p - 0.25) < 1e-5


def test_each_window_gets_special_tokens():
    model = FakeSoftmaxModel(0.4)
    score_paragraph(
        "long",
        FakeTok(600),
        model,
        head=HEAD_SOFTMAX,
        ai_index=1,
        max_length=512,
        stride=256,
    )
    ids = model.last_batch_ids
    assert ids is not None
    assert int(ids[0, 0].item()) == 101
    # last non-pad should be SEP on the first window
    row = ids[0].tolist()
    content = [t for t in row if t != 0]
    assert content[0] == 101
    assert content[-1] == 102


class LenSigmoidModel:
    """P(AI) 随序列里非 pad 的长度变，用来核对成批打分后结果没有错位。"""

    def parameters(self):
        yield torch.nn.Parameter(torch.zeros(1))

    def __call__(self, **batch):
        lengths = batch["attention_mask"].sum(dim=1).float()
        logits = (lengths / 10.0 - 1.0).unsqueeze(1)
        return SimpleNamespace(logits=logits)


class VarTok(FakeTok):
    def __init__(self):
        super().__init__(0)

    def encode(self, text, add_special_tokens=False):
        return [1] * len(text.split())


def test_score_short_texts_keeps_input_order():
    texts = ["a b c d e f g h", "a", "a b c", "a b c d e"]
    got = score_short_texts(texts, VarTok(), LenSigmoidModel(), head=HEAD_SIGMOID, max_length=64)
    # 特殊 token 两个；与逐条打分一致，且保持输入顺序。
    want = [
        score_paragraph(t, VarTok(), LenSigmoidModel(), head=HEAD_SIGMOID, max_length=64, stride=32)
        for t in texts
    ]
    assert got == pytest.approx(want)
    assert got[0] > got[3] > got[2] > got[1]


def test_score_short_texts_splits_into_batches():
    model = FakeSoftmaxModel(0.4)
    got = score_short_texts(["x"] * 40, FakeTok(5), model, head=HEAD_SOFTMAX, ai_index=1)
    assert got == pytest.approx([0.4] * 40)
    assert int(model.last_batch_ids.shape[0]) <= 16


def test_score_short_texts_empty():
    assert score_short_texts([], FakeTok(1), FakeSoftmaxModel(0.4), head=HEAD_SOFTMAX, ai_index=1) == []
