"""守住 API 边界的护栏：校验顺序、畸形请求体、体积上限、推理闸门。"""

import asyncio
import threading
import time
from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from app.errors import DetectError
from app.extract import MAX_UPLOAD_BYTES
from app.main import _MULTIPART_SLACK, _read_upload, app, gated, hub


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


def _chunks(total: int, size: int = 1024 * 1024):
    """没有 Content-Length 的分块请求体：httpx 遇到生成器会走 chunked。"""
    sent = 0
    while sent < total:
        n = min(size, total - sent)
        sent += n
        yield b"x" * n


def test_declared_oversize_json_is_rejected():
    c = TestClient(app)
    r = c.post(
        "/api/detect",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": str(MAX_UPLOAD_BYTES + 1)},
    )
    assert r.status_code == 400
    assert r.json()["error"] == "payload_too_large"


def test_chunked_oversize_json_is_rejected_without_content_length():
    """分块传输不带 Content-Length，只能靠实际读到的字节数拦。"""
    c = TestClient(app)
    r = c.post(
        "/api/detect",
        content=_chunks(MAX_UPLOAD_BYTES + 1),
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert r.json()["error"] == "payload_too_large"


def test_chunked_oversize_multipart_is_rejected():
    c = TestClient(app)
    r = c.post(
        "/api/preview",
        content=_chunks(MAX_UPLOAD_BYTES + _MULTIPART_SLACK + 1),
        headers={"Content-Type": "multipart/form-data; boundary=x"},
    )
    assert r.status_code == 400
    assert r.json()["error"] == "payload_too_large"


def test_normal_chunked_json_still_works():
    hub.loaded = {"zh": False, "en": True}
    hub.phase = "ready"
    c = TestClient(app)
    body = b'{"lang": "fr", "text": "hello"}'
    r = c.post(
        "/api/detect",
        content=iter([body[:10], body[10:]]),
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert r.json()["error"] == "lang_required"  # 读到了，照常走校验


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
