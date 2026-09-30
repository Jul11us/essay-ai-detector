import asyncio
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.bilingual import run_bilingual
from app.bodylimit import BodyLimitMiddleware
from app.errors import DetectError
from app.extract import MAX_UPLOAD_BYTES, extract_from_bytes
from app.length import PREVIEW_MAX_CHARS, SECTION_MIN_CHARS
from app.loader import ModelHub
from app.markers import find_markers
from app.pipeline import require_lang, run_detect, run_sentences
from app.rhythm import measure_rhythm
from app.static import mount_frontend

hub = ModelHub()

# 一次只跑一个检测。模型前向是 CPU 密集的，连点或开两个标签页会让
# 多个请求同时抢核心，内存和响应时间都抖。用 threading 信号量而不是
# asyncio.Lock：锁在 to_thread 的工作线程里拿，不会绑死事件循环
# （asyncio 的锁会被首个使用它的循环绑住，测试里每个 TestClient 一个循环）。
infer_gate = threading.Semaphore(1)

# multipart 除文件本身外还有 boundary / 表单字段，留一点余量。
_MULTIPART_SLACK = 1024 * 1024


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("DETECTOR_SKIP_LOAD") != "1":
        hub.load_in_background()
    yield


app = FastAPI(title="作文 AI 写作检测", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# 后加的中间件在外层：先数请求体字节，再谈 CORS 和路由。
app.add_middleware(
    BodyLimitMiddleware, limit=MAX_UPLOAD_BYTES, multipart_slack=_MULTIPART_SLACK
)


# 多久查一次客户端是否已断开（点了取消、超时、关了标签页）。
_DISCONNECT_POLL_S = 0.25


def gated(fn, *args):
    """把一次推理放进闸门里串行执行。"""
    with infer_gate:
        return fn(*args)


def cancellable(score_fn, cancel: threading.Event):
    """每次前向之前看一眼取消标记。单段打分和成批逐句打分都用它包。

    前端取消只是断开连接，`to_thread` 里的推理不会跟着停，还一直占着闸门，
    下一次检测就得排在一个没人要的结果后面。按段检查，最多再跑完当前这一段。
    """

    def score(*args):
        if cancel.is_set():
            raise DetectError("cancelled")
        return score_fn(*args)

    return score


async def run_until_disconnect(request: Request, fn, *args):
    """在闸门里跑 `fn(cancel, *args)`，客户端断开就置位 `cancel`，让它尽早停下。"""
    cancel = threading.Event()

    async def watch() -> None:
        while not cancel.is_set():
            if await request.is_disconnected():
                cancel.set()
                return
            await asyncio.sleep(_DISCONNECT_POLL_S)

    watcher = asyncio.create_task(watch())
    try:
        return await asyncio.to_thread(
            gated, fn, cancel, *args
        )
    finally:
        watcher.cancel()


async def _read_upload(upload) -> bytes:
    """分块读，超限就停，不把整个文件读进内存。"""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise DetectError("payload_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/status")
def status() -> dict:
    return hub.status()


@app.exception_handler(DetectError)
async def detect_error_handler(request, exc: DetectError):
    return JSONResponse(
        {"error": exc.code, "message": exc.message},
        status_code=exc.http_status,
    )


def _detect_document(cancel, lang, text, filename, file_bytes, floor):
    score = cancellable(hub.score, cancel)
    return run_detect(lang, text, filename, file_bytes, score, length_floor=floor)


def _bilingual(cancel, text, en, zh, filename, file_bytes):
    return run_bilingual(text, en, zh, filename, file_bytes, cancellable(hub.score, cancel))


def _sentences(cancel, lang, text):
    return run_sentences(
        lang,
        text,
        cancellable(hub.score, cancel),
        score_many=cancellable(hub.score_many, cancel),
    )


def _str_field(source, key: str) -> str | None:
    """表单或 JSON 里的字符串字段；缺失或类型不对一律当没给。"""
    value = source.get(key)
    return value if isinstance(value, str) else None


async def _json_object(request: Request) -> dict:
    try:
        data = await request.json()
    except DetectError:
        raise  # 体积超限等已分类的错误别被当成格式问题
    except Exception as exc:
        raise DetectError("bad_request") from exc
    if not isinstance(data, dict):
        raise DetectError("bad_request")
    return data


@app.post("/api/preview")
async def preview(request: Request):
    """Extract a local upload before scoring so the user can inspect what will be read."""
    if "multipart/form-data" not in request.headers.get("content-type", ""):
        raise DetectError("bad_request")
    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        raise DetectError("empty")
    raw = await _read_upload(upload)
    if not raw:
        raise DetectError("empty")
    extracted = await asyncio.to_thread(
        extract_from_bytes, getattr(upload, "filename", "") or "", raw
    )
    return {
        "text": extracted.text[:PREVIEW_MAX_CHARS],
        "truncated": len(extracted.text) > PREVIEW_MAX_CHARS,
        "char_count": len(extracted.text),
        "paragraph_count": len(extracted.natural_paragraphs or ()),
    }


@app.post("/api/detect")
async def detect(request: Request):
    ctype = request.headers.get("content-type", "")
    file_bytes = None
    filename = None
    lang = None
    text = None
    en = None
    zh = None
    scope = None
    if "multipart/form-data" in ctype:
        form = await request.form()
        lang = form.get("lang")
        text = _str_field(form, "text")
        en = _str_field(form, "en")
        zh = _str_field(form, "zh")
        upload = form.get("file")
        if upload is not None and hasattr(upload, "read"):
            file_bytes = await _read_upload(upload)
            filename = getattr(upload, "filename", None)
            if file_bytes == b"":
                file_bytes = None
    else:
        data = await _json_object(request)
        lang = data.get("lang")
        text = _str_field(data, "text")
        en = _str_field(data, "en")
        zh = _str_field(data, "zh")
        scope = _str_field(data, "scope")
    # 先校验语言再问模型：否则 lang=fr 且模型未加载时会返回 503 而不是 400。
    lang = require_lang(lang)
    hub.assert_ready(lang)
    if lang == "bi":
        return await run_until_disconnect(
            request, _bilingual, text, en, zh, filename, file_bytes
        )
    # 单段重测不能套整篇的 200 字符下限，否则改一句就被拒。
    floor = SECTION_MIN_CHARS if scope == "paragraph" else None
    return await run_until_disconnect(
        request, _detect_document, lang, text, filename, file_bytes, floor
    )


@app.post("/api/sentences")
async def sentences(request: Request):
    """高分段的单句前向。和整篇检测共用同一把闸，避免两路一起抢 CPU。"""
    data = await _json_object(request)
    lang = require_lang(data.get("lang"))
    if lang == "bi":
        raise DetectError("lang_required")
    hub.assert_ready(lang)
    text = _str_field(data, "text")
    return await run_until_disconnect(request, _sentences, lang, text)


@app.post("/api/explain")
async def explain_view(request: Request):
    """套话和句长不跑模型。单段重测之后用它刷新整篇的解释，不必重跑其它段。"""
    data = await _json_object(request)
    lang = require_lang(data.get("lang"))
    if lang == "bi":
        raise DetectError("lang_required")
    text = _str_field(data, "text") or ""
    return {"markers": find_markers(text, lang), "rhythm": measure_rhythm(text)}


# 单容器部署：DETECTOR_STATIC_DIR 指向前端构建产物，后端一并伺服。必须放在最后，
# 让上面所有 /api 路由先注册。开发时不设，前端由 Vite 另起。
_static_dir = os.environ.get("DETECTOR_STATIC_DIR")
if _static_dir:
    mount_frontend(app, Path(_static_dir))
