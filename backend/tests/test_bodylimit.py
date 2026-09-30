"""BodyLimitMiddleware 本身：用很小的上限，不必真的发 20 MB。"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.bodylimit import BodyLimitMiddleware
from app.errors import DetectError


def make_app(limit: int, slack: int = 0) -> TestClient:
    app = FastAPI()
    app.add_middleware(BodyLimitMiddleware, limit=limit, multipart_slack=slack)

    @app.exception_handler(DetectError)
    async def handler(_request, exc: DetectError):
        return JSONResponse({"error": exc.code}, status_code=exc.http_status)

    @app.post("/echo")
    async def echo(request: Request):
        return {"size": len(await request.body())}

    return TestClient(app)


def test_body_at_the_limit_passes():
    r = make_app(100).post("/echo", content=b"x" * 100)
    assert r.status_code == 200
    assert r.json() == {"size": 100}


def test_body_over_the_limit_is_rejected():
    r = make_app(100).post("/echo", content=b"x" * 101)
    assert r.status_code == 400
    assert r.json() == {"error": "payload_too_large"}


def test_chunked_body_is_counted_across_chunks():
    chunks = (b"x" * 40 for _ in range(3))  # 120 字节，分三块，没有 Content-Length
    r = make_app(100).post("/echo", content=chunks)
    assert r.json() == {"error": "payload_too_large"}


def test_multipart_gets_its_slack():
    client = make_app(100, slack=50)
    headers = {"Content-Type": "multipart/form-data; boundary=x"}
    assert client.post("/echo", content=b"x" * 140, headers=headers).status_code == 200
    assert client.post("/echo", content=b"x" * 151, headers=headers).status_code == 400
    # 非 multipart 不享受余量
    assert client.post("/echo", content=b"x" * 140).status_code == 400
