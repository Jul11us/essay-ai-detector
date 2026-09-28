import re
from dataclasses import dataclass
from io import BytesIO

from app.errors import DetectError

_ALLOWED = {".txt", ".docx", ".pdf"}

# 上传上限。作业正文撑死几百 KB，20 MB 留足余量；
# 没有这个上限时 `await upload.read()` 会把任意大的文件整个读进内存。
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True)
class ExtractedText:
    text: str
    natural_paragraphs: tuple[str, ...] | None


def _extension(filename: str) -> str:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1].lower()


def extract_from_bytes(filename: str, data: bytes) -> ExtractedText:
    ext = _extension(filename)
    if ext not in _ALLOWED:
        raise DetectError("parse_failed")
    if ext == ".txt":
        text = _decode_txt(data).strip()
        if not text:
            raise DetectError("empty")
        return ExtractedText(text=text, natural_paragraphs=None)
    if ext == ".pdf":
        return _extract_pdf(data)
    return _extract_docx(data)


def _decode_txt(data: bytes) -> str:
    for enc in ("utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise DetectError("parse_failed")


def _extract_pdf(data: bytes) -> ExtractedText:
    """文字版 PDF 抽文本。抽出来是空的，就当成扫描件拦住，不拿空串去打分。"""
    try:
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception as exc:
                raise DetectError("parse_failed") from exc
        pages = [(page.extract_text() or "") for page in reader.pages]
    except DetectError:
        raise
    except Exception as exc:
        raise DetectError("parse_failed") from exc
    paras = pdf_paragraphs(pages)
    if not paras:
        raise DetectError("scanned_pdf")
    return ExtractedText(text="\n\n".join(paras), natural_paragraphs=tuple(paras))


def _extract_docx(data: bytes) -> ExtractedText:
    try:
        from docx import Document

        doc = Document(BytesIO(data))
    except Exception as exc:
        raise DetectError("parse_failed") from exc
    paras = tuple(p.text.strip() for p in doc.paragraphs if p.text.strip())
    text = "\n\n".join(paras).strip()
    if not text:
        raise DetectError("empty")
    return ExtractedText(text=text, natural_paragraphs=paras)


# ---- PDF 重新拼段 ----
# pypdf 按「行」吐文本：行尾一个 \n，页与页之间没有任何段落信息。
# 直接按页拼接的话，一页就被当成一个自然段，跨页的段被从中间切开，
# 页眉、页脚、页码也混进正文参与打分。这里把行重新拼回段落。

# 页码行：「3」「- 3 -」「第 3 页」「第3页 共10页」「Page 3」「3 / 10」「Page 3 of 10」「iv」（只看页首页尾）。
_PAGE_NUM = re.compile(
    r"^[\s\-–—]*(?:"
    r"(?:page\s*)?\d{1,4}(?:\s*(?:/|of)\s*\d{1,4})?"
    r"|第\s*\d{1,4}\s*页(?:\s*[,，]?\s*共\s*\d{1,4}\s*页)?"
    r"|(?-i:[ivx]{1,5})"  # 小写罗马页码；限定字母，免得「Civil」这种词被当页码
    r")[\s\-–—]*$",
    re.I,
)
# 页首、页尾各看这么多个非空行，找页眉页脚。
_EDGE_LINES = 2
_CJK_CHAR = re.compile(r"[　-〿㐀-鿿＀-￯]")
# 显示宽度比常规行宽短这么多，就认为这一行在这里收尾（段末或标题）。
_SHORT_LINE_RATIO = 0.75


def _edge_key(line: str) -> str:
    """页眉页脚里常带页码，把数字抹平后再比较是否每页重复。"""
    return re.sub(r"\d+", "#", re.sub(r"\s+", "", line))


def _edge_indexes(lines: list[str]) -> list[int]:
    filled = [i for i, line in enumerate(lines) if line]
    return sorted(set(filled[:_EDGE_LINES] + filled[-_EDGE_LINES:]))


def _strip_page_furniture(pages: list[list[str]]) -> list[list[str]]:
    """去掉页首 / 页尾的页码行，以及在多数页重复出现的页眉页脚。空行原样保留。"""
    counts: dict[str, int] = {}
    for lines in pages:
        for key in {_edge_key(lines[i]) for i in _edge_indexes(lines)}:
            counts[key] = counts.get(key, 0) + 1
    n = len(pages)
    repeated = {key for key, c in counts.items() if n >= 2 and c >= 2 and c * 2 >= n}

    cleaned: list[list[str]] = []
    for lines in pages:
        drop = {
            i
            for i in _edge_indexes(lines)
            if _PAGE_NUM.match(lines[i]) or _edge_key(lines[i]) in repeated
        }
        cleaned.append([line for i, line in enumerate(lines) if i not in drop])
    return cleaned


def _display_width(line: str) -> int:
    """中文一个字约等于两个英文字母宽。中英混排时按字数比会把中文行全当成短行。"""
    return len(line) + len(_CJK_CHAR.findall(line))


def _join_lines(prev: str, nxt: str) -> str:
    if prev.endswith("-") and len(prev) > 1 and prev[-2].isalpha() and nxt[:1].islower():
        return prev[:-1] + nxt  # 英文断词连字符
    if _CJK_CHAR.match(prev[-1]) or _CJK_CHAR.match(nxt[0]):
        return prev + nxt  # 中文行间不补空格
    return prev + " " + nxt


def pdf_paragraphs(page_texts: list[str]) -> list[str]:
    """把 pypdf 按页、按行的输出拼回自然段。

    判段依据（PDF 里没有更可靠的信号）：
    - 空行一定分段；
    - 一行明显短于常规行宽，说明排版在这里提前换行，是段末或标题；
    - 换页本身不分段，跨页的段会接起来。
    """
    pages = [[line.strip() for line in text.splitlines()] for text in page_texts]
    stream = [line for lines in _strip_page_furniture(pages) for line in lines]

    widths = sorted(_display_width(line) for line in stream if line)
    if not widths:
        return []
    # 用偏上的分位数当「满行宽」，免得短行多的文档把基准拉低。
    full = widths[round((len(widths) - 1) * 0.8)]
    short = full * _SHORT_LINE_RATIO

    paras: list[str] = []
    buf = ""
    for line in stream:
        if not line:
            if buf:
                paras.append(buf)
                buf = ""
            continue
        buf = _join_lines(buf, line) if buf else line
        if _display_width(line) < short:
            paras.append(buf)
            buf = ""
    if buf:
        paras.append(buf)
    return paras
