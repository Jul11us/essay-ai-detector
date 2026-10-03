import asyncio
import os
import hashlib
import json
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from app.bilingual import run_bilingual
from app.bodylimit import BodyLimitMiddleware
from app.errors import DetectError
from app.extract import MAX_UPLOAD_BYTES, extract_from_bytes
from app.length import PREVIEW_MAX_CHARS, SECTION_MIN_CHARS
from app.language import suggest_language
from app.loader import ModelHub
from app.markers import find_markers
from app.pipeline import require_lang, run_detect, run_sentences
from app.rhythm import measure_rhythm
from app.evaluation import AnalyzeRequest, ManifestRequest, analyze_predictions, validate_samples
from app.word_report import WordRequest, build_word_report
from app.static import mount_frontend
from app.document_scope import document_blocks, scoped_document, MAX_SCOPE_BLOCKS, MAX_SCOPE_CHARS

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


def _detect_document(cancel, lang, text, filename, file_bytes, floor, selection=None, fingerprint=None):
    score = cancellable(hub.score, cancel)
    extracted, coverage = None, None
    if file_bytes is not None:
        extracted, coverage = scoped_document(extract_from_bytes(filename or "upload.bin", file_bytes), filename or "upload.bin", file_bytes, selection, fingerprint)
    elif selection is not None:
        raise DetectError("invalid_selection")
    result = run_detect(
        lang, text, filename, file_bytes, score, length_floor=floor,
        model_revision=hub.revisions.get(lang),
        calibration_scope="paragraph" if floor is not None else "document",
        extracted_override=extracted,
    )
    if coverage is not None:
        result["detection_scope"] = coverage
    return result


def _bilingual(cancel, text, en, zh, filename, file_bytes, selection=None, fingerprint=None):
    coverage = None
    if file_bytes is not None:
        extracted, coverage = scoped_document(extract_from_bytes(filename or "upload.bin", file_bytes), filename or "upload.bin", file_bytes, selection, fingerprint)
        text, en, zh, file_bytes = extracted.text, None, None, None
    elif selection is not None:
        raise DetectError("invalid_selection")
    result = run_bilingual(text, en, zh, filename, file_bytes, cancellable(hub.score, cancel), model_revisions=hub.revisions)
    if coverage is not None:
        result["detection_scope"] = coverage
        for side in ("en", "zh"):
            if result[side] and "score" in result[side]:
                result[side]["detection_scope"] = coverage
    return result


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
    blocks = await asyncio.to_thread(document_blocks, extracted)
    scope_available = len(blocks) <= MAX_SCOPE_BLOCKS and len(extracted.text) <= MAX_SCOPE_CHARS
    return {
        "text": extracted.text[:PREVIEW_MAX_CHARS],
        "truncated": len(extracted.text) > PREVIEW_MAX_CHARS,
        "char_count": len(extracted.text),
        "paragraph_count": len(extracted.natural_paragraphs or ()),
        "language_hint": suggest_language(extracted.text),
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "blocks": blocks if scope_available else [],
        "scope_available": scope_available,
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
    selection, fingerprint = None, None
    if "multipart/form-data" in ctype:
        form = await request.form()
        lang = form.get("lang")
        text = _str_field(form, "text")
        en = _str_field(form, "en")
        zh = _str_field(form, "zh")
        fingerprint = _str_field(form, "source_sha256")
        if "selection" in form:
            try:
                selection = json.loads(form["selection"])
            except (TypeError, ValueError):
                raise DetectError("invalid_selection")
            if selection is None:
                raise DetectError("invalid_selection")
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
        selection = data.get("selection")
    # 先校验语言再问模型：否则 lang=fr 且模型未加载时会返回 503 而不是 400。
    lang = require_lang(lang)
    hub.assert_ready(lang)
    if lang == "bi":
        return await run_until_disconnect(
            request, _bilingual, text, en, zh, filename, file_bytes, selection, fingerprint
        )
    # 单段重测不能套整篇的 200 字符下限，否则改一句就被拒。
    floor = SECTION_MIN_CHARS if scope == "paragraph" else None
    return await run_until_disconnect(
        request, _detect_document, lang, text, filename, file_bytes, floor, selection, fingerprint
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


@app.post("/api/reports/word")
async def word_report(request: Request):
    try:
        payload = WordRequest.model_validate(await _json_object(request))
    except ValidationError:
        return JSONResponse({"error": "invalid_report", "message": "报告内容不完整或格式不正确，请重新检测后导出。"}, status_code=400)
    content = await asyncio.to_thread(build_word_report, payload.result)
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": 'attachment; filename="ai-writing-report.docx"', "Cache-Control": "no-store"})


@app.post("/api/evaluation/manifest")
async def evaluation_manifest(request: Request):
    try:
        payload = ManifestRequest.model_validate(await _json_object(request))
        samples = validate_samples(payload.samples)
    except ValidationError:
        return JSONResponse({"error": "invalid_manifest", "message": "样本清单格式不正确：检查编号、文件名、中英语言、human/ai/mixed 标签和来源字段。每批最多 1000 份。"}, status_code=400)
    except ValueError as exc:
        return JSONResponse({"error": "invalid_manifest", "message": str(exc)}, status_code=400)
    return {"samples": samples}


@app.post("/api/evaluation/analyze")
async def evaluation_analyze(request: Request):
    try:
        payload = AnalyzeRequest.model_validate(await _json_object(request))
        result = await asyncio.to_thread(analyze_predictions, payload)
    except ValidationError:
        return JSONResponse({"error": "invalid_evaluation", "message": "评测记录格式不正确：检查标签、0–1 分数、判定档位、来源和模型版本。每批最多 1000 份。"}, status_code=400)
    except ValueError:
        return JSONResponse({"error": "invalid_evaluation", "message": "评测记录存在重复样本、校准/测试组泄漏或模型版本不一致，请核对清单后重新导入。"}, status_code=400)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


# 单容器部署：DETECTOR_STATIC_DIR 指向前端构建产物，后端一并伺服。必须放在最后，
# 让上面所有 /api 路由先注册。开发时不设，前端由 Vite 另起。
_static_dir = os.environ.get("DETECTOR_STATIC_DIR")
if _static_dir:
    mount_frontend(app, Path(_static_dir))
