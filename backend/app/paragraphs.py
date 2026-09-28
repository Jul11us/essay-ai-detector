import re

from app.errors import DetectError

_MULTI_NL = re.compile(r"\n{2,}")
_SENTENCE = re.compile(r"(?<=[.!?。！？])")

# 一个「打分单元」的字符上限。这不是模型上下文，而是打包粒度：
# - zh：800 字 ≈ 800 token，超过 zhv3 的 510 token 预算，所以打分阶段每段通常切 2 个窗口
# - en：1200 字符 ≈ 300 token，远低于 Vanguard 的 8192 上下文，所以一段一窗
# 打分阶段的真实预算见 scoring.EN_INFER_TOKENS 与 loader._load_softmax 的 max_length。
SEGMENT_CHARS: dict[str, int] = {"zh": 800, "en": 1200}

# 去 trim 后短于这个长度的段不参与打分。标题、残句只有几个 token，
# 单段分数方差极大：实测一篇人类作文里 29 字符（4 词）的题干可得 16.7%，
# 而同文正文段落接近 0%。它权重虽小（20 字符 vs 全篇上千字符），
# 但和有分量的段并排显示会让人误以为「这段有问题」。
MIN_SEGMENT_CHARS = 20


def _limit(lang: str) -> int:
    return SEGMENT_CHARS[lang]


def _clean(parts: list[str]) -> list[str]:
    return [p.strip() for p in parts if p.strip() and len(p.strip()) >= MIN_SEGMENT_CHARS]


def _chunk_chars(text: str, limit: int) -> list[str]:
    return [text[i : i + limit] for i in range(0, len(text), limit)]


def _pack_sentences(text: str, limit: int) -> list[str]:
    bits = [b.strip() for b in _SENTENCE.split(text) if b.strip()]
    if not bits:
        return _chunk_chars(text, limit)
    chunks: list[str] = []
    buf = ""
    for bit in bits:
        trial = buf + bit if buf else bit
        if buf and len(trial) > limit:
            chunks.append(buf)
            buf = bit
        else:
            buf = trial
    if buf:
        chunks.append(buf)
    out: list[str] = []
    for ch in chunks:
        if len(ch) <= limit:
            out.append(ch)
        else:
            out.extend(_chunk_chars(ch, limit))
    return _clean(out)


def split_paragraphs(
    text: str,
    lang: str,
    natural_paragraphs: tuple[str, ...] | None = None,
) -> list[str]:
    limit = _limit(lang)
    if natural_paragraphs:
        parts = _clean(list(natural_paragraphs))
    else:
        parts = _clean(_MULTI_NL.split(text))
        if not parts and text.strip():
            parts = _clean([text])

    if len(parts) == 1 and len(parts[0]) > limit:
        parts = _clean(parts[0].split("\n"))

    expanded: list[str] = []
    for p in parts:
        if len(p) > limit:
            packed = _pack_sentences(p, limit)
            expanded.extend(packed if packed else _chunk_chars(p, limit))
        else:
            expanded.append(p)
    expanded = _clean(expanded)
    if not expanded:
        raise DetectError("too_short")
    return expanded


_REFERENCE_HEADING = re.compile(
    r"^(?:references|bibliography|works cited|参考文献|引用文献|参考资料)\s*[:：]?$",
    re.I,
)


def prepare_scoring_text(
    text: str,
    natural_paragraphs: tuple[str, ...] | None = None,
) -> tuple[str, tuple[str, ...] | None, list[dict[str, str]]]:
    """Conservatively remove standalone front matter and bibliography before scoring.

    The ignored spans are returned to the UI, so exclusion is inspectable.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    raw_blocks = list(natural_paragraphs) if natural_paragraphs else _MULTI_NL.split(normalized)
    blocks: list[str] = []
    for raw_block in raw_blocks:
        lines = raw_block.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        heading_index = next(
            (i for i, line in enumerate(lines) if _REFERENCE_HEADING.fullmatch(line.strip())),
            None,
        )
        if heading_index is None:
            blocks.append("\n".join(lines))
        else:
            before = "\n".join(lines[:heading_index]).strip()
            after = "\n".join(lines[heading_index + 1:]).strip()
            if before:
                blocks.append(before)
            blocks.append(lines[heading_index].strip())
            if after:
                blocks.append(after)
    cleaned = [block.strip() for block in blocks if block.strip()]
    scored: list[str] = []
    ignored: list[dict[str, str]] = []
    in_references = False
    body_exists = any(len(block) >= 80 for block in cleaned)
    for i, block in enumerate(cleaned):
        if _REFERENCE_HEADING.fullmatch(block):
            in_references = True
        if in_references:
            reason = "参考文献"
        elif (
            i < 3
            and not scored
            and body_exists
            and len(block) < 80
            and "\n" not in block
            and not re.search(r"[.!?。！？]$", block)
        ):
            reason = "标题或副标题"
        elif len(block) < MIN_SEGMENT_CHARS:
            reason = "过短"
        else:
            scored.append(block)
            continue
        ignored.append({"text": block, "reason": reason})
    return "\n\n".join(scored), tuple(scored) if natural_paragraphs else None, ignored
