"""中文正文和英文摘要分开打分，避免整篇丢进去触发语种冲突。"""

from __future__ import annotations

import re

from app.errors import DISCLAIMER, DetectError
from app.language import _CJK, _LATIN
from app.pipeline import ScoreFn, run_detect

# 摘要常常短于整篇下限。低于这个地板才拒绝；介于地板和整篇下限之间仍打分，
# 置信度会按现有规则落成「低」。
BI_FLOOR = {"zh": 60, "en": 80}

NOTE = (
    "英文和中文分开打分，不会混成一个总分。"
    "上传整篇时，按段落里中英文字哪边更多来归类；独立成段的参考文献标题及其后内容会从评分中排除。"
)


def split_by_script(text: str) -> tuple[str, str]:
    """返回 (英文, 中文)。一段里中文字不少于英文字母，就归中文。"""
    blocks = [b.strip() for b in re.split(r"\n+", text) if b.strip()]
    en_parts: list[str] = []
    zh_parts: list[str] = []
    for block in blocks:
        cjk = len(_CJK.findall(block))
        latin = len(_LATIN.findall(block))
        if cjk == 0 and latin == 0:
            continue
        if cjk >= latin:
            zh_parts.append(block)
        else:
            en_parts.append(block)
    return "\n\n".join(en_parts), "\n\n".join(zh_parts)


def _one(lang: str, text: str, score_fn: ScoreFn) -> dict | None:
    raw = text.strip()
    if not raw:
        return None
    try:
        return run_detect(lang, raw, None, None, score_fn, length_floor=BI_FLOOR[lang])
    except DetectError as exc:
        # 取消是整次请求的事，不能当成「这一部分太短」塞进结果里接着跑另一半。
        if exc.code == "cancelled":
            raise
        return {"error": exc.code, "message": exc.message}


def _usable(part: dict | None) -> bool:
    return bool(part) and "score" in part


def run_bilingual(
    text: str | None,
    en: str | None,
    zh: str | None,
    filename: str | None,
    file_bytes: bytes | None,
    score_fn: ScoreFn,
) -> dict:
    if file_bytes is not None:
        from app.extract import extract_from_bytes

        extracted = extract_from_bytes(filename or "upload.bin", file_bytes)
        en_text, zh_text = split_by_script(extracted.text)
    else:
        en_text = (en or "").strip()
        zh_text = (zh or "").strip()
        if not en_text and not zh_text:
            en_text, zh_text = split_by_script(text or "")

    en_result = _one("en", en_text, score_fn)
    zh_result = _one("zh", zh_text, score_fn)
    if not _usable(en_result) and not _usable(zh_result):
        for part in (en_result, zh_result):
            if part and "error" in part:
                raise DetectError(part["error"])
        raise DetectError("empty")
    return {
        "lang": "bi",
        "note": NOTE,
        "disclaimer": DISCLAIMER,
        "en": en_result,
        "zh": zh_result,
    }
