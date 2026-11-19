import hashlib
import json
import math
import threading
from types import SimpleNamespace

import pytest
import torch
from fastapi.testclient import TestClient

from app import model_artifacts
from app.errors import DetectError
from app.loader import ModelHub
from app.pipeline import run_detect
from app.second_opinion import EnglishSecondOpinion, REVIEW_THRESHOLD, default_en_review_path

TEXT = "This paragraph describes a local visit with details and personal observations. " * 8


def detect(second=None, score=.1, lang="en", **kwargs):
    text = TEXT if lang == "en" else "这是学生写的文章，记录每天的学习经历和生活感受。" * 30
    return run_detect(lang, text, None, None, lambda *_: score, second_score_fn=second, **kwargs)


@pytest.mark.parametrize("score,promoted", [
    (math.nextafter(REVIEW_THRESHOLD, 0), False),
    (REVIEW_THRESHOLD, True),
    (math.nextafter(REVIEW_THRESHOLD, 1), True),
    (1.0, True),
])
def test_review_threshold_only_changes_low_verdict_and_explanation(score, promoted):
    baseline = detect()
    result = detect(lambda _: score)
    assert result["second_opinion_score"] == score
    assert result["paraphrase_review"] is promoted
    assert result["verdict"] == ("uncertain" if promoted else "low")
    for key in ("score", "confidence", "mixed_variance", "paragraphs", "model_id", "model_revision", "calibration"):
        assert result[key] == baseline[key]
    if promoted:
        assert result["review_risk"] == "unclear"
        assert "第二模型" in result["reading"]
        assert "第二模型" in result["explanation"]


@pytest.mark.parametrize("score,lang,scope", [(.5, "en", "document"), (.9, "en", "document"),
                                              (.1, "zh", "document"), (.1, "en", "paragraph")])
def test_non_low_chinese_and_paragraph_results_are_untouched(score, lang, scope):
    def forbidden(_):
        pytest.fail("second model must not run")
    assert detect(forbidden, score, lang, calibration_scope=scope) == detect(None, score, lang, calibration_scope=scope)


@pytest.mark.parametrize("value", [None, float("nan"), float("inf"), -.1, 1.1])
def test_unavailable_or_invalid_second_score_is_byte_identical(value):
    assert json.dumps(detect(lambda _: value)) == json.dumps(detect())


def test_second_model_error_falls_back_but_cancellation_propagates():
    def fail(_):
        raise RuntimeError("inference failed")
    assert detect(fail) == detect()
    def cancel(_):
        raise DetectError("cancelled")
    with pytest.raises(DetectError) as error:
        detect(cancel)
    assert error.value.code == "cancelled"


def test_second_model_reads_only_prepared_scoring_text():
    seen = []
    text = "Essay title\n\n" + TEXT + "\n\nReferences\n\n" + "Excluded reference. " * 20
    result = run_detect("en", text, None, None, lambda *_: .1, second_score_fn=lambda t: seen.append(t) or .9)
    assert seen == [TEXT.strip()]
    assert result["paraphrase_review"] is True


def test_empty_input_never_calls_second_model():
    calls = []
    with pytest.raises(DetectError):
        run_detect("en", "", None, None, lambda *_: .1, second_score_fn=lambda t: calls.append(t))
    assert not calls


def test_disabled_never_loads_or_scores(monkeypatch):
    monkeypatch.delenv("DETECTOR_EN_REVIEW", raising=False)
    model = EnglishSecondOpinion()
    model.load_in_background()
    assert model._thread is None
    assert model.score(TEXT) is None
    assert model.status()["state"] == "disabled"
    monkeypatch.setenv("DETECTOR_EN_REVIEW", "true")
    assert EnglishSecondOpinion().enabled is False


def test_load_failure_is_optional_and_does_not_block_readiness(monkeypatch, tmp_path):
    monkeypatch.setenv("DETECTOR_EN_REVIEW", "1")
    monkeypatch.setenv("EN_REVIEW_MODEL_PATH", str(tmp_path))
    hub = ModelHub()
    hub.loaded = {"en": True, "zh": True}
    hub._sync_phase()
    hub.second_opinion._load_safely()
    assert hub.status()["en_review"]["state"] == "unavailable"
    assert hub.status()["phase"] == "ready"
    assert hub.status()["models"] == {"en": True, "zh": True}
    assert detect(hub.second_opinion.score) == detect()
    assert default_en_review_path() == tmp_path


def test_optional_loader_runs_independently(monkeypatch):
    monkeypatch.setenv("DETECTOR_EN_REVIEW", "1")
    hub = ModelHub()
    blocker = threading.Event()
    def load_optional():
        assert hub.loaded["en"]
        blocker.wait()
    monkeypatch.setattr(hub, "_load_vanguard", lambda: None)
    monkeypatch.setattr(hub, "_download_zh", lambda: "")
    monkeypatch.setattr(hub, "_load_zh", lambda _: None)
    monkeypatch.setattr("app.loader.check_zh_direction", lambda _: {})
    monkeypatch.setattr(hub.second_opinion, "_load", load_optional)
    hub.load_in_background()
    try:
        hub._thread.join(timeout=2)
        assert hub.status()["phase"] == "ready"
        assert hub.status()["loading"] is False
        assert hub.status()["en_review"]["state"] == "loading"
    finally:
        blocker.set()
        hub.second_opinion._thread.join(timeout=2)


@pytest.fixture
def fake_loader(monkeypatch):
    import transformers
    from app import second_opinion

    monkeypatch.setenv("DETECTOR_EN_REVIEW", "1")
    monkeypatch.setattr(second_opinion, "verify_en_review_artifacts", lambda _: None)
    calls = []
    class FakeTokenizer:
        def __call__(self, text, **kwargs):
            calls.append(("tokenize", kwargs))
            return {"input_ids": torch.tensor([[1, 2]])}
    class FakeModel:
        config = SimpleNamespace(id2label={0: "Fake", 1: "Real"})
        def to(self, device):
            assert str(device) == "cpu"
        def eval(self):
            pass
        def __call__(self, **kwargs):
            return SimpleNamespace(logits=torch.tensor([[2., 0.]]))
    model = FakeModel()
    loading = {"unexpected_keys": ["roberta.pooler.dense.bias", "roberta.pooler.dense.weight"]}
    def tokenizer_load(path, **kwargs):
        calls.append(("tokenizer_load", kwargs))
        return FakeTokenizer()
    def model_load(path, *, local_files_only, use_safetensors, attn_implementation, output_loading_info):
        calls.append(("model_load", {"local_files_only": local_files_only, "use_safetensors": use_safetensors,
                                     "attn_implementation": attn_implementation, "output_loading_info": output_loading_info}))
        return model, loading
    monkeypatch.setattr(transformers.AutoTokenizer, "from_pretrained", tokenizer_load)
    monkeypatch.setattr(transformers.AutoModelForSequenceClassification, "from_pretrained", model_load)
    return model, loading, calls


def test_local_loader_direction_and_first_512_tokens(fake_loader):
    model, loading, calls = fake_loader
    review = EnglishSecondOpinion()
    review._load_safely()
    assert review.status()["state"] == "ready"
    assert review.score(TEXT) == pytest.approx(torch.softmax(torch.tensor([2., 0.]), -1)[0].item())
    assert dict(calls)["tokenizer_load"] == {"local_files_only": True}
    assert dict(calls)["model_load"]["local_files_only"] is True
    assert dict(calls)["model_load"]["use_safetensors"] is True
    assert dict(calls)["tokenize"] == {"truncation": True, "max_length": 512, "return_tensors": "pt"}


@pytest.mark.parametrize("kind", ["direction", "missing", "unexpected", "mismatched"])
def test_wrong_model_or_incomplete_weights_fail_closed(fake_loader, kind):
    model, loading, _ = fake_loader
    if kind == "direction":
        model.config = SimpleNamespace(id2label={0: "Real", 1: "Fake"})
    else:
        loading[kind + "_keys"] = ["classifier.weight"]
    review = EnglishSecondOpinion()
    review._load_safely()
    assert review.state == "unavailable"
    assert review.score(TEXT) is None


def test_runtime_failure_falls_back(fake_loader):
    review = EnglishSecondOpinion()
    review._load_safely()
    review._model = lambda **_: (_ for _ in ()).throw(RuntimeError("failed"))
    assert detect(review.score) == detect()
    assert review.state == "unavailable"


def test_pinned_review_artifacts_reject_corruption_and_extra_tokenizer(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_bytes(b"expected")
    monkeypatch.setattr(model_artifacts, "EN_REVIEW_MODEL_SHA256", {"config.json": hashlib.sha256(b"expected").hexdigest()})
    model_artifacts.verify_en_review_artifacts(tmp_path)
    extra = tmp_path / "special_tokens_map.json"
    extra.write_text("{}")
    with pytest.raises(RuntimeError, match="special_tokens_map"):
        model_artifacts.verify_en_review_artifacts(tmp_path)
    extra.unlink()
    path.write_bytes(b"corrupt")
    with pytest.raises(RuntimeError, match="config.json"):
        model_artifacts.verify_en_review_artifacts(tmp_path)


def test_api_switch_off_is_byte_identical_and_on_is_review_only(monkeypatch):
    from app.main import app, hub

    monkeypatch.delenv("DETECTOR_EN_REVIEW", raising=False)
    optional = EnglishSecondOpinion()
    monkeypatch.setattr(hub, "second_opinion", optional)
    monkeypatch.setattr(hub, "loaded", {"en": True, "zh": True})
    monkeypatch.setattr(hub, "score", lambda *_: .1)
    client = TestClient(app)
    payload = {"lang": "en", "text": TEXT}
    baseline = client.post("/api/detect", json=payload)
    monkeypatch.setattr(optional, "score", lambda _: REVIEW_THRESHOLD)
    assert client.post("/api/detect", json=payload).content == baseline.content
    optional.enabled = True
    result = client.post("/api/detect", json=payload).json()
    assert result["verdict"] == "uncertain"
    assert result["score"] == baseline.json()["score"]
    assert result["paraphrase_review"] is True
    paragraph = client.post("/api/detect", json={**payload, "scope": "paragraph"}).json()
    assert paragraph["verdict"] == "low"
    assert "second_opinion_score" not in paragraph
