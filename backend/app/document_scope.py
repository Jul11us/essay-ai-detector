"""Inspectable paragraph selection; only server-extracted text can enter the score."""

from __future__ import annotations

import hashlib
import re

from app.errors import DetectError
from app.extract import ExtractedText

MAX_SCOPE_BLOCKS = 2000
MAX_SCOPE_CHARS = 200_000
_HEADING = re.compile(
    r"^(?:\d+(?:\.\d+)*[.、\s]*)?(摘要|abstract|参考文献|引用文献|参考资料|references|bibliography|works cited|附录(?:\s*[A-Z一二三\d])?|appendix(?:\s*[A-Z\d])?|引言|前言|正文|结论|introduction|conclusion)\s*[:：]?$",
    re.I,
)


def document_blocks(extracted: ExtractedText) -> list[dict]:
    raw = extracted.natural_paragraphs or tuple(
        re.split(r"\n{2,}", extracted.text.replace("\r\n", "\n"))
    )
    parts: list[str] = []
    for part in raw:
        pending: list[str] = []
        for line in part.splitlines():
            if _HEADING.fullmatch(line.strip()):
                if pending:
                    parts.append("\n".join(pending).strip())
                    pending = []
                parts.append(line.strip())
            else:
                pending.append(line)
        if pending:
            parts.append("\n".join(pending).strip())
    blocks = []
    section = "正文"
    for text in filter(None, parts):
        heading = _HEADING.fullmatch(text)
        if heading:
            label = heading.group(1).lower()
            section = (
                "参考文献"
                if label
                in {"参考文献", "引用文献", "参考资料", "references", "bibliography", "works cited"}
                else "摘要"
                if label in {"摘要", "abstract"}
                else "附录"
                if label.startswith(("附录", "appendix"))
                else "正文"
            )
        kind = "引用" if text.startswith(">") else section
        blocks.append(
            {
                "index": len(blocks),
                "text": text,
                "section": kind,
                "char_count": len(re.sub(r"\s", "", text)),
            }
        )
    return blocks


def scoped_document(
    extracted: ExtractedText, filename: str, raw: bytes, selection: object, fingerprint: object
) -> tuple[ExtractedText, dict]:
    blocks = document_blocks(extracted)
    if selection is None:
        chosen = set(range(len(blocks)))
        selected = extracted
    else:
        if (
            len(blocks) > MAX_SCOPE_BLOCKS
            or len(extracted.text) > MAX_SCOPE_CHARS
            or not isinstance(selection, list)
            or not selection
            or len(selection) > MAX_SCOPE_BLOCKS
            or any(type(i) is not int or i < 0 or i >= len(blocks) for i in selection)
            or len(set(selection)) != len(selection)
            or fingerprint != hashlib.sha256(raw).hexdigest()
        ):
            raise DetectError("invalid_selection")
        chosen = set(selection)
        parts = tuple(b["text"] for b in blocks if b["index"] in chosen)
        selected = ExtractedText(text="\n\n".join(parts), natural_paragraphs=parts)
    excluded = [
        {"text": b["text"], "reason": f"用户排除：{b['section']}（提取第 {b['index'] + 1} 段）"}
        for b in blocks
        if b["index"] not in chosen
    ]
    info = {
        "source_name": filename,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "total_blocks": len(blocks),
        "selected_blocks": len(chosen),
        "total_chars": sum(b["char_count"] for b in blocks),
        "selected_chars": sum(b["char_count"] for b in blocks if b["index"] in chosen),
        "excluded": excluded,
        "note": "分数仅对应所选文字。标题、过短段落及参考文献仍按检测规则排除；文件版式、图片和脚注不参与评分。",
    }
    return selected, info
