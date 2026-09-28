"""守住 API 边界的护栏：校验顺序、畸形请求体、体积上限、推理闸门。"""

import asyncio
import threading
import time
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.errors import DetectError
from app.extract import MAX_UPLOAD_BYTES
from app.main import _read_upload, _reject_oversized, app, gated, hub


def make_request(**headers: str) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return Request({"type": "http", "method": "POST", "path": "/api/detect", "headers": raw})


def test_invalid_lang_is_400_even_when_models_are_not_ready():
    """校验顺序：先看语言，别让 lang=fr 撞上 503。"""
    hub.loaded = {"zh": False, "en": False}
    hub.phase = "downloading"
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "fr", "text": "word " * 80})
    assert r.status_code == 400
    assert r.json()["error"] == "lang_required"


def test_missing_lang_is_400():
    hub.loaded = {"zh": False, "en": True}
    hub.phase = "ready"
    c = TestClient(app)
    r = c.post("/api/detect", json={"text": "word " * 80})
    assert r.status_code == 400
    assert r.json()["error"] == "lang_required"


def test_malformed_json_is_bad_request():
    c = TestClient(app)
    r = c.post("/api/detect", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_non_object_json_is_bad_request():
    c = TestClient(app)
    r = c.post("/api/detect", json=[1, 2, 3])
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_declared_oversize_body_is_rejected_before_parsing():
    with pytest.raises(DetectError) as ei:
        _reject_oversized(make_request(**{"content-length": str(MAX_UPLOAD_BYTES + 1)}))
    assert ei.value.code == "payload_too_large"


def test_declared_normal_body_passes_the_length_guard():
    _reject_oversized(make_request(**{"content-length": "1024"}))


def test_missing_content_length_does_not_block():
    _reject_oversized(make_request())


class _EndlessUpload:
    """永远读不完的假上传，用来验证读取阶段自己会喊停。"""

    def __init__(self) -> None:
        self.sent = 0

    async def read(self, size: int = -1) -> bytes:
        if self.sent > MAX_UPLOAD_BYTES + 2:
            return b""
        self.sent += size
        return b"x" * size


def test_streaming_read_stops_at_the_limit():
    with pytest.raises(DetectError) as ei:
        asyncio.run(_read_upload(_EndlessUpload()))
    assert ei.value.code == "payload_too_large"


class _SmallUpload:
    def __init__(self, data: bytes) -> None:
        self._buf = BytesIO(data)

    async def read(self, size: int = -1) -> bytes:
        return self._buf.read(size)


def test_streaming_read_returns_small_files_whole():
    assert asyncio.run(_read_upload(_SmallUpload(b"hello"))) == b"hello"


def test_infer_gate_serializes_concurrent_work():
    """并发闸门：同时提交多个任务，实际只允许一个在跑。"""
    active = 0
    peak = 0
    guard = threading.Lock()

    def job() -> None:
        def work() -> None:
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            time.sleep(0.05)
            with guard:
                active -= 1

        gated(work)

    threads = [threading.Thread(target=job) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak == 1


def test_status_exposes_head_and_label_check():
    hub.phase = "ready"
    hub.detail = "就绪"
    hub.loaded = {"zh": True, "en": True}
    hub._heads = {"zh": "softmax", "en": "sigmoid"}
    hub._ai_index = {"zh": 1, "en": None}
    hub._label_check = {"zh": {"ai_style": 0.9994, "human_style": 0.4591}}
    c = TestClient(app)
    body = c.get("/api/status").json()
    assert body["heads"]["zh"] == {"kind": "softmax", "ai_index": 1}
    assert body["heads"]["en"] == {"kind": "sigmoid", "ai_index": None}
    assert body["label_check"]["zh"]["ai_style"] == 0.9994
