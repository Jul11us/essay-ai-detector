import os

os.environ["DETECTOR_SKIP_LOAD"] = "1"

from fastapi.testclient import TestClient

from app.main import app, hub


def setup_function():
    hub.phase = "ready"
    hub.detail = "就绪"
    hub.loaded = {"zh": False, "en": True}
    hub.score = lambda text, lang: 0.33


def test_health():
    c = TestClient(app)
    r = c.get("/api/health")
    assert r.status_code == 200


def test_preview_extracts_file_without_model():
    hub.loaded = {"zh": False, "en": False}
    c = TestClient(app)
    r = c.post("/api/preview", files={"file": ("essay.txt", "First paragraph.\n\nSecond paragraph.".encode("utf-8"), "text/plain")})
    assert r.status_code == 200
    assert r.json()["text"] == "First paragraph.\n\nSecond paragraph."
    assert "score" not in r.json()


def test_preview_limits_response_but_keeps_full_length():
    c = TestClient(app)
    raw = ("A" * 5200).encode("utf-8")
    r = c.post("/api/preview", files={"file": ("long.txt", raw, "text/plain")})
    assert r.status_code == 200
    assert r.json()["char_count"] == 5200
    assert len(r.json()["text"]) == 5000
    assert r.json()["truncated"] is True


def test_preview_rejects_bad_upload():
    c = TestClient(app)
    r = c.post("/api/preview", files={"file": ("essay.pdf", b"%PDF", "application/pdf")})
    assert r.status_code == 400
    assert r.json()["error"] == "parse_failed"


def test_detect_json():
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "en", "text": "word " * 80})
    assert r.status_code == 200
    body = r.json()
    assert "score" in body
    assert "error" not in body
    assert body["model_id"] == "ShantanuT01/vanguard-ai-text-detector"


def test_detect_too_short():
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "en", "text": "short"})
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "too_short"
    assert "score" not in body


def test_english_ok_while_chinese_not_loaded():
    hub.loaded = {"zh": False, "en": True}
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "en", "text": "word " * 80})
    assert r.status_code == 200


def test_chinese_not_ready():
    hub.loaded = {"zh": False, "en": True}
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "zh", "text": "字" * 200})
    assert r.status_code == 503
    assert r.json()["error"] == "models_not_ready"


def test_bilingual_needs_both_models():
    hub.loaded = {"zh": False, "en": True}
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "bi", "en": "word " * 40, "zh": "字" * 80})
    assert r.status_code == 503
    assert r.json()["error"] == "models_not_ready"


def test_bilingual_scores_each_side():
    hub.loaded = {"zh": True, "en": True}
    hub.score = lambda text, lang: 0.2 if lang == "en" else 0.7
    c = TestClient(app)
    r = c.post(
        "/api/detect",
        json={
            "lang": "bi",
            "en": "This abstract discusses climate policy and local evidence in plain detail. " * 4,
            "zh": "本文讨论气候政策与地方证据，篇幅足够单独打分。" * 4,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["lang"] == "bi"
    assert body["en"]["score"] == 0.2
    assert body["zh"]["score"] == 0.7


def test_sentence_scan_and_explain_do_not_need_a_full_essay():
    hub.loaded = {"zh": False, "en": True}
    hub.score = lambda text, lang: 0.91 if "AI" in text else 0.12
    c = TestClient(app)
    scanned = c.post(
        "/api/sentences",
        json={"lang": "en", "text": "AI wrote this whole sentence here. Humans vary the next one."},
    )
    assert scanned.status_code == 200
    assert scanned.json()["sentences"][0]["highlight"] == "high"
    explained = c.post(
        "/api/explain",
        json={"lang": "en", "text": "We delve into this pivotal issue today."},
    )
    assert explained.status_code == 200
    phrases = [row["phrase"] for row in explained.json()["markers"]]
    assert "delve into" in phrases
    assert "lengths" in explained.json()["rhythm"]


def test_paragraph_scope_accepts_a_single_block():
    hub.loaded = {"zh": False, "en": True}
    hub.score = lambda text, lang: 0.2
    c = TestClient(app)
    text = "Cats sat on the mat and looked around the room. " * 3
    rejected = c.post("/api/detect", json={"lang": "en", "text": text})
    assert rejected.status_code == 400
    assert rejected.json()["error"] == "too_short"
    accepted = c.post(
        "/api/detect", json={"lang": "en", "text": text, "scope": "paragraph"}
    )
    assert accepted.status_code == 200
    assert accepted.json()["paragraphs"][0]["score"] == 0.2


def test_not_ready():
    hub.loaded = {"zh": False, "en": False}
    hub.phase = "downloading"
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "en", "text": "word " * 80})
    assert r.status_code == 503
    assert r.json()["error"] == "models_not_ready"


def test_cancel_flag_stops_before_next_paragraph():
    import threading

    import pytest

    from app.errors import DetectError
    from app.main import cancellable

    calls = []
    cancel = threading.Event()

    def score(text, lang):
        calls.append(text)
        cancel.set()  # 模拟第一段跑完时客户端断开
        return 0.5

    wrapped = cancellable(score, cancel)
    wrapped("a", "en")
    with pytest.raises(DetectError) as ei:
        wrapped("b", "en")
    assert ei.value.code == "cancelled"
    assert calls == ["a"]


def test_bilingual_does_not_swallow_cancel():
    import pytest

    from app.bilingual import run_bilingual
    from app.errors import DetectError

    def score(text, lang):
        raise DetectError("cancelled")

    with pytest.raises(DetectError) as ei:
        run_bilingual(None, "word " * 40, "中文" * 60, None, None, score)
    assert ei.value.code == "cancelled"


def test_sentences_endpoint_takes_lower_of_single_and_context():
    c = TestClient(app)
    hub.score = lambda text, lang: 0.9 if "robot" in text else 0.1
    r = c.post(
        "/api/sentences",
        json={"lang": "en", "text": "A robot wrote this long line. A person wrote this other line."},
    )
    assert r.status_code == 200
    rows = r.json()["sentences"]
    assert rows[0]["score"] == 0.9
    assert rows[1]["score"] == 0.1
