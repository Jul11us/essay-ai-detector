# Essay AI Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Amendment 2026-09-13:** English detection uses the already-local Vanguard model (`experiments/models/vanguard`, Hugging Face `ShantanuT01/vanguard-ai-text-detector`). Head is a **single sigmoid logit**, context 8192, `local_files_only`. Do **not** load `yuchuantian/AIGC_detector_env3`. Chinese remains `AIGC_detector_zhv3` and is optional at startup: English can detect while Chinese is still missing.

**Goal:** Ship a localhost Chinese website where university students paste or upload a `.txt`/`.docx` essay, pick 中文 or 英文, and get a conservative open-source AI-likelihood score with per-paragraph breakdown.

**Architecture:** A FastAPI process owns text extraction, hard reject rules, paragraph splitting, local transformers inference, and JSON. A Vite React process owns the single Chinese page and proxies `/api` to `127.0.0.1:8000`. No rewrite, no PDF, no cloud inference, no history.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, transformers, torch (CPU), python-docx, huggingface_hub, modelscope, pytest; Node.js 20+, Vite, React, TypeScript, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-13-essay-ai-detector-design.md`

## Global Constraints

- Python 3.11+, Node.js 20+.
- Backend: `fastapi`, `uvicorn`, `transformers`, `torch`, `python-docx`, `huggingface_hub`; ModelScope only as weight-download fallback.
- Frontend: Vite + React + TypeScript; UI language is Chinese only.
- Models: English `ShantanuT01/vanguard-ai-text-detector` from `VANGUARD_MODEL_PATH` or `experiments/models/vanguard` (sigmoid, 8192). Chinese `yuchuantian/AIGC_detector_zhv3` (softmax, optional). Never assume softmax `label=1` for Vanguard.
- Download order: Hugging Face Hub → `https://hf-mirror.com` → ModelScope `snapshot_download`. Never send essay text to a third-party scoring API.
- Ports: backend `127.0.0.1:8000`, frontend `127.0.0.1:5173`, frontend proxies `/api`.
- Error messages (verbatim):
  - `lang_required`：请先选择中文或英文。
  - `empty`：没有读到正文。
  - `too_short`：文本太短，无法给出可靠结果（中文至少约 150 字，英文至少约 200 个字符）。
  - `too_long`：文本超出第一版上限（中文约 10000 字，英文约 8000 词），请拆成多篇再测。
  - `language_mismatch`：正文语言和所选语言明显不符。请改选后重试；本站不会在选错时给出分数。
  - `parse_failed`：无法读取文件。请使用 UTF-8 或 GBK 的 .txt，或未损坏的 .docx。
  - `models_not_ready`：模型还在准备，请稍后再试。
  - `infer_failed`：本机推理失败，未生成分数。
- Disclaimer (verbatim): `本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。`
- Failed detect responses contain only `error` and `message` — never `score`.
- Do not implement rewrite, PDF, auto language switching, accounts, history, or cloud deploy configs.
- Do not commit unless the human explicitly asked to commit in this conversation; if they did not, skip every Commit step and continue.

## File map

```
.gitignore
README.md
backend/requirements.txt
backend/pytest.ini
backend/app/__init__.py
backend/app/errors.py
backend/app/extract.py
backend/app/length.py
backend/app/language.py
backend/app/paragraphs.py
backend/app/aggregate.py
backend/app/explain.py
backend/app/scoring.py
backend/app/loader.py
backend/app/pipeline.py
backend/app/main.py
backend/tests/test_extract.py
backend/tests/test_length.py
backend/tests/test_language.py
backend/tests/test_paragraphs.py
backend/tests/test_aggregate.py
backend/tests/test_explain.py
backend/tests/test_scoring.py
backend/tests/test_pipeline.py
backend/tests/test_api.py
frontend/package.json
frontend/vite.config.ts
frontend/tsconfig.json
frontend/tsconfig.node.json
frontend/index.html
frontend/src/main.tsx
frontend/src/App.tsx
frontend/src/App.css
frontend/src/api.ts
frontend/src/types.ts
frontend/src/copy.ts
frontend/src/App.test.tsx
frontend/src/setupTests.ts
frontend/vitest.config.ts
```

---

### Task 1: Backend scaffold and error types

**Files:**
- Create: `.gitignore`
- Create: `backend/requirements.txt`
- Create: `backend/pytest.ini`
- Create: `backend/app/__init__.py`
- Create: `backend/app/errors.py`
- Test: `backend/tests/test_errors.py`

**Interfaces:**
- Consumes: nothing
- Produces: `class DetectError(Exception)` with `code: str`, `http_status: int`, `message: str`; `MESSAGES: dict[str, str]`; `HTTP_STATUS: dict[str, int]`; `DISCLAIMER: str`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_errors.py`:

```python
from app.errors import DetectError, DISCLAIMER, MESSAGES


def test_language_mismatch_message_is_exact():
    err = DetectError("language_mismatch")
    assert err.http_status == 400
    assert err.message == (
        "正文语言和所选语言明显不符。请改选后重试；本站不会在选错时给出分数。"
    )
    assert err.message == MESSAGES["language_mismatch"]


def test_models_not_ready_is_503():
    err = DetectError("models_not_ready")
    assert err.http_status == 503


def test_infer_failed_is_500():
    err = DetectError("infer_failed")
    assert err.http_status == 500


def test_disclaimer_is_exact():
    assert DISCLAIMER == "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。"
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend`:

```bash
python -m pytest tests/test_errors.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app'` or collection error.

- [ ] **Step 3: Write minimal implementation**

`.gitignore`:

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
node_modules/
dist/
.DS_Store
*.egg-info/
.hf-cache/
.modelscope/
```

`backend/requirements.txt`:

```
fastapi>=0.115.0
uvicorn>=0.32.0
python-multipart>=0.0.12
python-docx>=1.1.2
huggingface_hub>=0.26.0
modelscope>=1.20.0
transformers>=4.45.0
torch>=2.4.0
pytest>=8.3.0
httpx>=0.27.0
```

`backend/pytest.ini`:

```ini
[pytest]
pythonpath = .
testpaths = tests
```

`backend/app/__init__.py` empty.

`backend/app/errors.py`:

```python
DISCLAIMER = "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。"

MESSAGES = {
    "lang_required": "请先选择中文或英文。",
    "empty": "没有读到正文。",
    "too_short": "文本太短，无法给出可靠结果（中文至少约 150 字，英文至少约 200 个字符）。",
    "too_long": "文本超出第一版上限（中文约 10000 字，英文约 8000 词），请拆成多篇再测。",
    "language_mismatch": "正文语言和所选语言明显不符。请改选后重试；本站不会在选错时给出分数。",
    "parse_failed": "无法读取文件。请使用 UTF-8 或 GBK 的 .txt，或未损坏的 .docx。",
    "models_not_ready": "模型还在准备，请稍后再试。",
    "infer_failed": "本机推理失败，未生成分数。",
}

HTTP_STATUS = {
    "lang_required": 400,
    "empty": 400,
    "too_short": 400,
    "too_long": 400,
    "language_mismatch": 400,
    "parse_failed": 400,
    "models_not_ready": 503,
    "infer_failed": 500,
}


class DetectError(Exception):
    def __init__(self, code: str) -> None:
        if code not in MESSAGES:
            raise ValueError(f"unknown detect error: {code}")
        self.code = code
        self.http_status = HTTP_STATUS[code]
        self.message = MESSAGES[code]
        super().__init__(self.message)
```

Create a venv in `backend` if none exists, then `pip install pytest python-docx python-multipart fastapi httpx` (full torch/transformers can wait until Task 8). For Task 1, `pip install pytest` is enough.

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_errors.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

Skip unless the user asked to commit. If they did:

```bash
git add .gitignore backend/requirements.txt backend/pytest.ini backend/app/__init__.py backend/app/errors.py backend/tests/test_errors.py
git commit -m "feat: add detect error codes and fixed Chinese messages"
```

---

### Task 2: Extract text from txt and docx

**Files:**
- Create: `backend/app/extract.py`
- Test: `backend/tests/test_extract.py`

**Interfaces:**
- Consumes: `DetectError`
- Produces: `def extract_from_bytes(filename: str, data: bytes) -> ExtractedText` where

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class ExtractedText:
    text: str
    natural_paragraphs: tuple[str, ...] | None
```

`natural_paragraphs` is a tuple of non-empty docx paragraphs, or `None` for txt. `text` is always the full stripped document (`"\n\n".join(paragraphs)` for docx). Raises `DetectError("parse_failed")` or `DetectError("empty")`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_extract.py`:

```python
from io import BytesIO

import pytest
from docx import Document
from app.errors import DetectError
from app.extract import extract_from_bytes


def test_utf8_txt():
    got = extract_from_bytes("a.TXT", "你好世界\n第二段".encode("utf-8"))
    assert got.text == "你好世界\n第二段"
    assert got.natural_paragraphs is None


def test_gbk_txt():
    raw = "中文作业".encode("gbk")
    got = extract_from_bytes("hw.txt", raw)
    assert "中文作业" in got.text


def test_docx_joins_nonempty_paragraphs():
    doc = Document()
    doc.add_paragraph("第一段")
    doc.add_paragraph("")
    doc.add_paragraph("第二段")
    buf = BytesIO()
    doc.save(buf)
    got = extract_from_bytes("paper.docx", buf.getvalue())
    assert got.natural_paragraphs == ("第一段", "第二段")
    assert got.text == "第一段\n\n第二段"


def test_rejects_pdf_extension():
    with pytest.raises(DetectError) as ei:
        extract_from_bytes("x.pdf", b"%PDF")
    assert ei.value.code == "parse_failed"


def test_empty_txt_is_empty_error():
    with pytest.raises(DetectError) as ei:
        extract_from_bytes("a.txt", b"   \n")
    assert ei.value.code == "empty"


def test_corrupt_docx():
    with pytest.raises(DetectError) as ei:
        extract_from_bytes("a.docx", b"not-a-zip")
    assert ei.value.code == "parse_failed"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pip install python-docx pytest
python -m pytest tests/test_extract.py -v
```

Expected: FAIL importing `app.extract`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/extract.py`:

```python
from dataclasses import dataclass
from io import BytesIO

from app.errors import DetectError

_ALLOWED = {".txt", ".docx"}


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
        text = _decode_txt(data)
        text = text.strip()
        if not text:
            raise DetectError("empty")
        return ExtractedText(text=text, natural_paragraphs=None)
    return _extract_docx(data)


def _decode_txt(data: bytes) -> str:
    for enc in ("utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise DetectError("parse_failed")


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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_extract.py tests/test_errors.py -v
```

Expected: all passed.

- [ ] **Step 5: Commit**

Skip unless asked. Message if committing: `feat: extract utf-8/gbk txt and docx paragraphs`

---

### Task 3: Length gates

**Files:**
- Create: `backend/app/length.py`
- Test: `backend/tests/test_length.py`

**Interfaces:**
- Consumes: `DetectError`
- Produces:
  - `def count_chars(text: str) -> int` — characters after removing all Unicode whitespace
  - `def count_words(text: str) -> int` — whitespace-separated tokens on stripped text
  - `def check_length(text: str, lang: str) -> None` — raises `too_short` / `too_long`. `lang` is `"zh"` or `"en"` (caller already validated).

Rules: zh `n_chars < 150` too_short, `n_chars > 10000` too_long; en `n_chars < 200` too_short, `n_words > 8000` too_long.

- [ ] **Step 1: Write the failing test**

```python
import pytest
from app.errors import DetectError
from app.length import check_length, count_chars, count_words


def test_count_chars_skips_whitespace():
    assert count_chars("a b\n你") == 3


def test_count_words():
    assert count_words("one  two\nthree") == 3


def test_zh_too_short():
    with pytest.raises(DetectError) as ei:
        check_length("短" * 149, "zh")
    assert ei.value.code == "too_short"


def test_zh_ok_at_150():
    check_length("字" * 150, "zh")


def test_zh_too_long():
    with pytest.raises(DetectError) as ei:
        check_length("字" * 10001, "zh")
    assert ei.value.code == "too_long"


def test_en_too_short():
    with pytest.raises(DetectError) as ei:
        check_length("a" * 199, "en")
    assert ei.value.code == "too_short"


def test_en_too_long_by_words():
    text = " ".join(["word"] * 8001)
    with pytest.raises(DetectError) as ei:
        check_length(text, "en")
    assert ei.value.code == "too_long"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_length.py -v
```

Expected: FAIL importing `app.length`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/length.py`:

```python
import re

from app.errors import DetectError

_WS = re.compile(r"\s+", re.UNICODE)


def count_chars(text: str) -> int:
    return len(_WS.sub("", text))


def count_words(text: str) -> int:
    parts = text.split()
    return len(parts)


def check_length(text: str, lang: str) -> None:
    n_chars = count_chars(text)
    if lang == "zh":
        if n_chars < 150:
            raise DetectError("too_short")
        if n_chars > 10000:
            raise DetectError("too_long")
        return
    if n_chars < 200:
        raise DetectError("too_short")
    if count_words(text) > 8000:
        raise DetectError("too_long")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_length.py -v
```

Expected: all passed.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: reject too-short and too-long essays without scoring`

---

### Task 4: Language mismatch gate

**Files:**
- Create: `backend/app/language.py`
- Test: `backend/tests/test_language.py`

**Interfaces:**
- Consumes: `DetectError`
- Produces: `def check_language(text: str, lang: str) -> None`

Count `cjk` as code points in Unicode ranges:

- `\u4E00-\u9FFF`
- `\u3400-\u4DBF`
- `\uF900-\uFAFF`
- `\U00020000-\U0002A6DF`

Count `latin` as `A-Za-z`. `ratio_cjk = cjk / (cjk + latin)`; if denominator is 0, return (do not reject). Reject `en` when `cjk >= 80` and `ratio_cjk > 0.50`. Reject `zh` when `latin >= 80` and `ratio_cjk < 0.15`.

- [ ] **Step 1: Write the failing test**

```python
import pytest
from app.errors import DetectError
from app.language import check_language


def test_en_with_long_chinese_rejected():
    text = "研究" * 60 + "hello"
    with pytest.raises(DetectError) as ei:
        check_language(text, "en")
    assert ei.value.code == "language_mismatch"


def test_zh_with_long_english_rejected():
    text = ("This is an English academic paragraph about markets. " * 8)
    with pytest.raises(DetectError) as ei:
        check_language(text, "zh")
    assert ei.value.code == "language_mismatch"


def test_english_essay_with_chinese_name_allowed():
    body = (
        "This paper argues that climate policy needs better data. "
        "Zhang Wei 张三 collected samples in 2019. "
    ) * 6
    check_language(body, "en")


def test_digits_only_not_rejected():
    check_language("1234567890", "en")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_language.py -v
```

Expected: FAIL importing `app.language`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/language.py`:

```python
import re

from app.errors import DetectError

_CJK = re.compile(
    r"[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\U00020000-\U0002A6DF]"
)
_LATIN = re.compile(r"[A-Za-z]")


def check_language(text: str, lang: str) -> None:
    cjk = len(_CJK.findall(text))
    latin = len(_LATIN.findall(text))
    denom = cjk + latin
    if denom == 0:
        return
    ratio_cjk = cjk / denom
    if lang == "en" and cjk >= 80 and ratio_cjk > 0.50:
        raise DetectError("language_mismatch")
    if lang == "zh" and latin >= 80 and ratio_cjk < 0.15:
        raise DetectError("language_mismatch")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_language.py -v
```

Expected: all passed.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: block scoring when selected language is clearly wrong`

---

### Task 5: Split paragraphs

**Files:**
- Create: `backend/app/paragraphs.py`
- Test: `backend/tests/test_paragraphs.py`

**Interfaces:**
- Consumes: `DetectError`
- Produces: `def split_paragraphs(text: str, lang: str, natural_paragraphs: tuple[str, ...] | None = None) -> list[str]`

Algorithm:

1. Start with `list(natural_paragraphs)` if it is not `None` and not empty, else split `text` on two or more newlines.
2. Strip each piece; drop pieces with `len(stripped) < 20`.
3. If after step 2 there is exactly one paragraph and its `len` is `> 800` (zh) or `> 1200` (en), split that paragraph on single newlines, strip, drop `< 20`.
4. For any remaining paragraph longer than `800` (zh) or `1200` (en), split on `[.!?。！？]` keeping separators, then pack pieces into chunks whose character length (not stripped join) stays `<= 800` (zh) or `<= 1200` (en).
5. If the final list is empty, raise `DetectError("too_short")`.

Do not call a tokenizer here. Token windows of 512/256 happen in `score_paragraph` (Task 8).

- [ ] **Step 1: Write the failing test**

```python
import pytest
from app.errors import DetectError
from app.paragraphs import split_paragraphs


def test_uses_natural_docx_paragraphs():
    text = "aaaaaaaaaaaaaaaaaaaa\n\nbbbbbbbbbbbbbbbbbbbb"
    natural = ("aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb")
    assert split_paragraphs(text, "en", natural) == list(natural)


def test_blank_line_split():
    a = "a" * 20
    b = "b" * 20
    assert split_paragraphs(f"{a}\n\n{b}", "en") == [a, b]


def test_drops_short_fragments_then_too_short():
    with pytest.raises(DetectError) as ei:
        split_paragraphs("hi\n\nok", "en")
    assert ei.value.code == "too_short"


def test_single_long_block_splits_on_newlines():
    a = "a" * 30
    b = "b" * 30
    blob = a + "\n" + b
    blob = blob + ("c" * 1200)
    parts = split_paragraphs(blob, "en")
    assert len(parts) >= 2
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_paragraphs.py -v
```

Expected: FAIL importing `app.paragraphs`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/paragraphs.py`:

```python
import re

from app.errors import DetectError

_MULTI_NL = re.compile(r"\n{2,}")
_SENTENCE = re.compile(r"(?<=[.!?。！？])")


def _limit(lang: str) -> int:
    return 800 if lang == "zh" else 1200


def _clean(parts: list[str]) -> list[str]:
    return [p.strip() for p in parts if p.strip() and len(p.strip()) >= 20]


def _pack_sentences(text: str, limit: int) -> list[str]:
    bits = [b.strip() for b in _SENTENCE.split(text) if b.strip()]
    if not bits:
        return _chunk_chars(text, limit)
    chunks: list[str] = []
    buf = ""
    for bit in bits:
        trial = (buf + bit) if not buf else (buf + bit)
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


def _chunk_chars(text: str, limit: int) -> list[str]:
    return [text[i : i + limit] for i in range(0, len(text), limit)]


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
```

If the last test is brittle, adjust the fixture so the single block is longer than 1200 characters with embedded newlines; do not weaken the `< 20` drop rule.

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_paragraphs.py -v
```

Expected: all passed. Fix `_pack_sentences` if a test fails; do not skip tests.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: split essays into scorable paragraphs without truncation`

---

### Task 6: Aggregate scores, confidence, verdict

**Files:**
- Create: `backend/app/aggregate.py`
- Test: `backend/tests/test_aggregate.py`

**Interfaces:**
- Consumes: `count_chars`, `count_words` from `app.length`
- Produces:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class ParagraphScore:
    index: int
    excerpt: str
    score: float
    verdict: str  # "low" | "uncertain" | "high"

@dataclass(frozen=True)
class AggregateResult:
    score: float
    verdict: str
    confidence: str  # "low" | "medium" | "high"
    mixed_variance: bool
    char_count: int
    word_count: int
    paragraphs: tuple[ParagraphScore, ...]

def excerpt(text: str, limit: int = 80) -> str: ...
def paragraph_verdict(score: float) -> str: ...
def aggregate(paragraphs: list[str], probs: list[float], lang: str) -> AggregateResult: ...
```

Rules:

- `w_i = count_chars(paragraphs[i])`; `score = sum(p_i * w_i) / sum(w_i)` rounded to 4 decimal places
- `std` is population stdev of `probs` if `len(probs) >= 2` else `0.0`
- `confidence`: `low` if `count_chars("".join(paragraphs)) < 400` or `len(paragraphs) < 2`; `high` if that char count `>= 1500` and `std < 0.15`; else `medium`
- `mixed_variance` if `std >= 0.25`
- document `verdict`: `low` if `score < 0.40`; `high` if `score >= 0.75` and `confidence != "low"`; else `uncertain`
- paragraph `verdict` uses only 0.40 / 0.75 cutoffs (no confidence demotion)
- excerpt: first 80 characters of the paragraph, plus `…` if longer (use the unicode ellipsis `…`)

- [ ] **Step 1: Write the failing test**

```python
from app.aggregate import aggregate, paragraph_verdict


def test_weighted_mean():
    a = "x" * 10
    b = "y" * 30
    result = aggregate([a, b], [0.2, 0.8], "en")
    expected = (0.2 * 10 + 0.8 * 30) / 40
    assert abs(result.score - round(expected, 4)) < 1e-9
    assert result.paragraphs[0].verdict == "low"
    assert result.paragraphs[1].verdict == "high"


def test_high_score_low_confidence_is_uncertain():
    p = "a" * 50
    result = aggregate([p], [0.80], "en")
    assert result.confidence == "low"
    assert result.verdict == "uncertain"


def test_high_score_medium_confidence_is_high():
    paras = ["a" * 250, "b" * 250]
    result = aggregate(paras, [0.80, 0.80], "en")
    assert result.confidence in {"medium", "high"}
    assert result.verdict == "high"


def test_mixed_variance_flag():
    paras = ["a" * 200, "b" * 200]
    result = aggregate(paras, [0.1, 0.9], "en")
    assert result.mixed_variance is True


def test_excerpt_ellipsis():
    from app.aggregate import excerpt
    assert excerpt("x" * 80) == "x" * 80
    assert excerpt("x" * 81) == "x" * 80 + "…"


def test_paragraph_verdict_bands():
    assert paragraph_verdict(0.39) == "low"
    assert paragraph_verdict(0.40) == "uncertain"
    assert paragraph_verdict(0.75) == "high"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_aggregate.py -v
```

Expected: FAIL importing `app.aggregate`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/aggregate.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from statistics import pstdev

from app.length import count_chars, count_words


@dataclass(frozen=True)
class ParagraphScore:
    index: int
    excerpt: str
    score: float
    verdict: str


@dataclass(frozen=True)
class AggregateResult:
    score: float
    verdict: str
    confidence: str
    mixed_variance: bool
    char_count: int
    word_count: int
    paragraphs: tuple[ParagraphScore, ...]


def excerpt(text: str, limit: int = 80) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def paragraph_verdict(score: float) -> str:
    if score < 0.40:
        return "low"
    if score >= 0.75:
        return "high"
    return "uncertain"


def aggregate(paragraphs: list[str], probs: list[float], lang: str) -> AggregateResult:
    if len(paragraphs) != len(probs):
        raise ValueError("paragraphs and probs length mismatch")
    weights = [count_chars(p) for p in paragraphs]
    total_w = sum(weights)
    raw = 0.0 if total_w == 0 else sum(p * w for p, w in zip(probs, weights)) / total_w
    score = round(raw, 4)
    std = 0.0 if len(probs) < 2 else pstdev(probs)
    joined = "".join(paragraphs)
    n_chars = count_chars(joined)
    n_words = count_words(joined)
    if n_chars < 400 or len(paragraphs) < 2:
        confidence = "low"
    elif n_chars >= 1500 and std < 0.15:
        confidence = "high"
    else:
        confidence = "medium"
    mixed_variance = std >= 0.25
    if score < 0.40:
        verdict = "low"
    elif score >= 0.75 and confidence != "low":
        verdict = "high"
    else:
        verdict = "uncertain"
    items = tuple(
        ParagraphScore(
            index=i,
            excerpt=excerpt(p),
            score=round(probs[i], 4),
            verdict=paragraph_verdict(probs[i]),
        )
        for i, p in enumerate(paragraphs)
    )
    return AggregateResult(
        score=score,
        verdict=verdict,
        confidence=confidence,
        mixed_variance=mixed_variance,
        char_count=n_chars,
        word_count=n_words,
        paragraphs=items,
    )
```

`lang` is accepted for call-site symmetry; unused is fine.

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_aggregate.py -v
```

Expected: all passed. If `pstdev` vs spec "population stdev" disagrees with a fixture, keep `pstdev` (population).

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: aggregate paragraph AI scores with conservative verdicts`

---

### Task 7: Explanation templates

**Files:**
- Create: `backend/app/explain.py`
- Test: `backend/tests/test_explain.py`

**Interfaces:**
- Consumes: `AggregateResult`
- Produces: `def explain(result: AggregateResult, model_id: str, lang: str) -> str`

Must include: model id; 这不是知网、Turnitin 或其他商业检测; 正式学术写作（结构完整、连接词多）可能推高分数; if `mixed_variance`, 各段差异大，不宜只看一个总分; if `confidence == "low"`, 文本偏短或段少，参考价值有限.

- [ ] **Step 1: Write the failing test**

```python
from app.aggregate import AggregateResult, ParagraphScore
from app.explain import explain


def _result(**kwargs):
    base = dict(
        score=0.5,
        verdict="uncertain",
        confidence="medium",
        mixed_variance=False,
        char_count=800,
        word_count=100,
        paragraphs=(
            ParagraphScore(0, "hello", 0.5, "uncertain"),
        ),
    )
    base.update(kwargs)
    return AggregateResult(**base)


def test_explain_contains_required_lines():
    text = explain(_result(), "yuchuantian/AIGC_detector_env3", "en")
    assert "yuchuantian/AIGC_detector_env3" in text
    assert "知网" in text
    assert "Turnitin" in text
    assert "正式学术写作" in text


def test_explain_mixed_and_low():
    text = explain(
        _result(mixed_variance=True, confidence="low"),
        "yuchuantian/AIGC_detector_zhv3",
        "zh",
    )
    assert "各段差异大，不宜只看一个总分" in text
    assert "参考价值有限" in text
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/test_explain.py -v
```

Expected: FAIL importing `app.explain`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/explain.py`:

```python
from app.aggregate import AggregateResult

def explain(result: AggregateResult, model_id: str, lang: str) -> str:
    lang_name = "中文" if lang == "zh" else "英文"
    parts = [
        f"本结果由开源{lang_name}检测模型 {model_id} 在本机计算，不是知网、Turnitin 或其他商业检测。",
        "正式学术写作（结构完整、连接词多）可能推高分数，请把分数当作倾向而非裁决。",
    ]
    if result.mixed_variance:
        parts.append("各段差异大，不宜只看一个总分。")
    if result.confidence == "low":
        parts.append("文本偏短或段少，参考价值有限。")
    return "\n".join(parts)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_explain.py -v
```

Expected: all passed.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: add fixed Chinese explanations for detect results`

---

### Task 8: Window scoring helpers (mocked model)

**Files:**
- Create: `backend/app/scoring.py`
- Test: `backend/tests/test_scoring.py`

**Interfaces:**
- Consumes: nothing from the detector models on disk
- Produces:
  - `MODEL_IDS: dict[str, str] = {"zh": "yuchuantian/AIGC_detector_zhv3", "en": "yuchuantian/AIGC_detector_env3"}`
  - `def resolve_ai_index(id2label: dict) -> int`
  - `def window_spans(n_tokens: int, max_length: int = 512, stride: int = 256) -> list[tuple[int, int]]`
  - `def score_paragraph(text: str, tokenizer, model, ai_index: int) -> float`

`resolve_ai_index`: iterate `id2label` items; keys may be `int` or `str`. A label is AI if the lowercased label contains any of `ai`, `generated`, `machine`, `fake`. If exactly one such class, return its int index. If none match, and there are two classes, prefer index `1` only after confirming the other label looks human (`human`, `real`, `original`); otherwise raise `RuntimeError("cannot resolve AI label")`.

`window_spans`: if `n_tokens <= max_length`, return `[(0, n_tokens)]`. Else start at 0, windows `[i, min(i+max_length, n_tokens)]`, step `stride`, always include a final window that covers the last token without going past `n_tokens`.

`score_paragraph`: tokenize with `tokenizer(text, return_tensors="pt", truncation=False, add_special_tokens=True)`; get `input_ids` length; for each span run `model` on that slice; softmax on logits[0]; take `ai_index` probability; weighted average by span length; return float. Tests must inject a fake tokenizer and fake model — no network, no weights.

- [ ] **Step 1: Write the failing test**

```python
import math
from types import SimpleNamespace

import torch
from app.scoring import resolve_ai_index, score_paragraph, window_spans


def test_resolve_ai_from_generated_label():
    assert resolve_ai_index({0: "HUMAN", 1: "AI_GENERATED"}) == 1
    assert resolve_ai_index({"0": "human", "1": "machine"}) == 1


def test_window_single_and_strided():
    assert window_spans(10) == [(0, 10)]
    spans = window_spans(600, max_length=512, stride=256)
    assert spans[0] == (0, 512)
    assert spans[-1][1] == 600
    assert all(b - a <= 512 for a, b in spans)


class FakeTok:
    def __init__(self, n: int):
        self.n = n

    def __call__(self, text, **kwargs):
        ids = torch.ones(1, self.n, dtype=torch.long)
        return {"input_ids": ids, "attention_mask": torch.ones_like(ids)}


class FakeModel:
    def __init__(self, p_ai: float):
        self.p_ai = p_ai

    def __call__(self, **batch):
        logit_ai = math.log(self.p_ai)
        logit_h = math.log(1 - self.p_ai)
        logits = torch.tensor([[logit_h, logit_ai]], dtype=torch.float)
        return SimpleNamespace(logits=logits)


def test_score_paragraph_uses_ai_index():
    p = score_paragraph("hello", FakeTok(8), FakeModel(0.25), ai_index=1)
    assert abs(p - 0.25) < 1e-5
```

- [ ] **Step 2: Run test to verify it fails**

Install torch (CPU) if missing: `pip install torch transformers`.

```bash
python -m pytest tests/test_scoring.py -v
```

Expected: FAIL importing `app.scoring`.

- [ ] **Step 3: Write minimal implementation**

`backend/app/scoring.py`:

```python
from __future__ import annotations

import math

import torch
import torch.nn.functional as F

MODEL_IDS = {
    "zh": "yuchuantian/AIGC_detector_zhv3",
    "en": "yuchuantian/AIGC_detector_env3",
}

_AI_MARKERS = ("ai", "generated", "machine", "fake")
_HUMAN_MARKERS = ("human", "real", "original")


def resolve_ai_index(id2label: dict) -> int:
    parsed: list[tuple[int, str]] = []
    for k, v in id2label.items():
        parsed.append((int(k), str(v)))
    ai = [i for i, lab in parsed if any(m in lab.lower() for m in _AI_MARKERS)]
    if len(ai) == 1:
        return ai[0]
    if len(parsed) == 2 and len(ai) == 0:
        human = [i for i, lab in parsed if any(m in lab.lower() for m in _HUMAN_MARKERS)]
        if len(human) == 1:
            other = [i for i, _ in parsed if i != human[0]]
            return other[0]
    raise RuntimeError("cannot resolve AI label")


def window_spans(n_tokens: int, max_length: int = 512, stride: int = 256) -> list[tuple[int, int]]:
    if n_tokens <= 0:
        return []
    if n_tokens <= max_length:
        return [(0, n_tokens)]
    spans: list[tuple[int, int]] = []
    start = 0
    while start < n_tokens:
        end = min(start + max_length, n_tokens)
        spans.append((start, end))
        if end == n_tokens:
            break
        start += stride
    return spans


def score_paragraph(text: str, tokenizer, model, ai_index: int) -> float:
    enc = tokenizer(text, return_tensors="pt", truncation=False, add_special_tokens=True)
    ids = enc["input_ids"]
    n = int(ids.shape[1])
    spans = window_spans(n)
    weighted = 0.0
    total = 0
    with torch.no_grad():
        for a, b in spans:
            batch = {k: v[:, a:b] for k, v in enc.items() if hasattr(v, "shape")}
            logits = model(**batch).logits
            if logits.dim() == 3:
                logits = logits[:, 0, :]
            prob = F.softmax(logits.float(), dim=-1)[0, ai_index].item()
            w = b - a
            weighted += prob * w
            total += w
    if total == 0:
        return 0.0
    return weighted / total
```

Remove unused `math` import if the implementation does not use it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_scoring.py -v
```

Expected: all passed.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: add sliding-window paragraph scoring helpers`

---

### Task 9: Model loader, pipeline, and FastAPI

**Files:**
- Create: `backend/app/loader.py`
- Create: `backend/app/pipeline.py`
- Create: `backend/app/main.py`
- Test: `backend/tests/test_pipeline.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: `extract_from_bytes`, `ExtractedText`, `check_length`, `check_language`, `split_paragraphs`, `aggregate`, `explain`, `score_paragraph`, `resolve_ai_index`, `MODEL_IDS`, `DetectError`, `DISCLAIMER`
- Produces:
  - `def run_detect(lang: str | None, text: str | None, filename: str | None, file_bytes: bytes | None, score_fn) -> dict`
  - `class ModelHub` with `status() -> dict`, `assert_ready()`, `score(text: str, lang: str) -> float`, `load_in_background()`
  - FastAPI app `app` with `GET /api/health`, `GET /api/status`, `POST /api/detect`

`run_detect` order: validate lang in `{zh,en}` else `lang_required`; if `file_bytes` is not None, `extract_from_bytes` (filename default `upload.bin` if missing); elif text, strip, empty → `empty`, wrap as `ExtractedText(text, None)`; else `empty`. Then `check_length`, `check_language`, `split_paragraphs`, `probs = [score_fn(p, lang) for p in parts]`, `aggregate`, `explain`. Catch unexpected exceptions from `score_fn` and raise `DetectError("infer_failed")`. Return dict with keys: `score`, `verdict`, `confidence`, `mixed_variance`, `char_count`, `word_count`, `model_id` (`MODEL_IDS[lang]`), `lang`, `explanation`, `disclaimer`, `paragraphs` as list of `{index, excerpt, score, verdict}`.

`ModelHub`: start `phase="downloading"`. `load_in_background` starts a daemon thread. Download each model dir with this sequence, local_files_only=False:

1. `huggingface_hub.snapshot_download(repo_id, endpoint=None)`
2. except: `snapshot_download(repo_id, endpoint="https://hf-mirror.com")`
3. except: `modelscope.snapshot_download(repo_id)` then also try `YuchuanTian/` + name after the slash if the first ModelScope id fails
4. still fail: `phase="error"`, `detail` set, stop

Then `AutoTokenizer.from_pretrained(path)` and `AutoModelForSequenceClassification.from_pretrained(path)`; `model.eval()`; device cuda if `torch.cuda.is_available()` else cpu; `ai_index = resolve_ai_index(model.config.id2label)`. When both langs loaded, `phase="ready"`. `score` calls `score_paragraph`. `assert_ready` raises `DetectError("models_not_ready")` if phase is not `ready`.

FastAPI: CORS allow `http://127.0.0.1:5173` and `http://localhost:5173`. Detect JSON body `{lang, text}` or multipart fields `lang` + `file`. On `DetectError`, return `JSONResponse({"error": code, "message": message}, status_code=http_status)`. Startup: `hub.load_in_background()`.

API tests use `run_detect` with a fake `score_fn` and `TestClient` with a hub monkeypatched to `phase="ready"` so detect does not download models.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_pipeline.py`:

```python
import pytest
from app.errors import DetectError
from app.pipeline import run_detect
from app.scoring import MODEL_IDS


def fake_score(text: str, lang: str) -> float:
    return 0.2 if text.startswith("H") else 0.8


def test_json_happy_path_weighted():
    human = "H" + "h" * 200
    ai = "A" + "a" * 600
    text = human + "\n\n" + ai
    out = run_detect("en", text, None, None, fake_score)
    assert "error" not in out
    assert out["model_id"] == MODEL_IDS["en"]
    assert out["paragraphs"]
    w_h, w_a = 201, 601
    expected = (0.2 * w_h + 0.8 * w_a) / (w_h + w_a)
    assert abs(out["score"] - round(expected, 4)) < 1e-9
    assert "知网" in out["explanation"]


def test_missing_lang():
    with pytest.raises(DetectError) as ei:
        run_detect(None, "a" * 400, None, None, fake_score)
    assert ei.value.code == "lang_required"


def test_mismatch_has_no_score_key_when_serialized_by_api_contract():
    with pytest.raises(DetectError) as ei:
        run_detect("en", "研究" * 80, None, None, fake_score)
    assert ei.value.code == "language_mismatch"
```

`backend/tests/test_api.py`:

```python
from fastapi.testclient import TestClient
from app.main import app, hub


def setup_function():
    hub.phase = "ready"
    hub.detail = "就绪"
    hub.loaded = {"zh": True, "en": True}


def test_health():
    c = TestClient(app)
    r = c.get("/api/health")
    assert r.status_code == 200


def test_detect_json():
    hub.score = lambda text, lang: 0.33
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "en", "text": "word " * 80})
    assert r.status_code == 200
    assert "score" in r.json()
    assert "error" not in r.json()


def test_detect_too_short():
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "zh", "text": "短"})
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "too_short"
    assert "score" not in body


def test_not_ready(monkeypatch):
    hub.phase = "downloading"
    c = TestClient(app)
    r = c.post("/api/detect", json={"lang": "en", "text": "word " * 80})
    assert r.status_code == 503
    assert r.json()["error"] == "models_not_ready"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pip install fastapi uvicorn python-multipart httpx
python -m pytest tests/test_pipeline.py tests/test_api.py -v
```

Expected: FAIL missing modules.

- [ ] **Step 3: Write minimal implementation**

`backend/app/pipeline.py`:

```python
from __future__ import annotations

from collections.abc import Callable

from app.aggregate import aggregate
from app.errors import DISCLAIMER, DetectError
from app.explain import explain
from app.extract import ExtractedText, extract_from_bytes
from app.language import check_language
from app.length import check_length
from app.paragraphs import split_paragraphs
from app.scoring import MODEL_IDS

ScoreFn = Callable[[str, str], float]


def run_detect(
    lang: str | None,
    text: str | None,
    filename: str | None,
    file_bytes: bytes | None,
    score_fn: ScoreFn,
) -> dict:
    if lang not in {"zh", "en"}:
        raise DetectError("lang_required")
    if file_bytes is not None:
        extracted = extract_from_bytes(filename or "upload.bin", file_bytes)
    else:
        raw = (text or "").strip()
        if not raw:
            raise DetectError("empty")
        extracted = ExtractedText(text=raw, natural_paragraphs=None)
    check_length(extracted.text, lang)
    check_language(extracted.text, lang)
    parts = split_paragraphs(extracted.text, lang, extracted.natural_paragraphs)
    try:
        probs = [float(score_fn(p, lang)) for p in parts]
    except DetectError:
        raise
    except Exception as exc:
        raise DetectError("infer_failed") from exc
    agg = aggregate(parts, probs, lang)
    model_id = MODEL_IDS[lang]
    return {
        "score": agg.score,
        "verdict": agg.verdict,
        "confidence": agg.confidence,
        "mixed_variance": agg.mixed_variance,
        "char_count": agg.char_count,
        "word_count": agg.word_count,
        "model_id": model_id,
        "lang": lang,
        "explanation": explain(agg, model_id, lang),
        "disclaimer": DISCLAIMER,
        "paragraphs": [
            {
                "index": p.index,
                "excerpt": p.excerpt,
                "score": p.score,
                "verdict": p.verdict,
            }
            for p in agg.paragraphs
        ],
    }
```

`backend/app/loader.py`:

```python
from __future__ import annotations

import threading
from app.errors import DetectError
from app.scoring import MODEL_IDS, resolve_ai_index, score_paragraph

HF_MIRROR = "https://hf-mirror.com"


class ModelHub:
    def __init__(self) -> None:
        self.phase = "downloading"
        self.detail = "正在准备模型…"
        self.loaded = {"zh": False, "en": False}
        self._lock = threading.Lock()
        self._models: dict = {}
        self._tokenizers: dict = {}
        self._ai_index: dict[str, int] = {}
        self._thread: threading.Thread | None = None

    def status(self) -> dict:
        return {
            "phase": self.phase,
            "detail": self.detail,
            "models": dict(self.loaded),
        }

    def assert_ready(self) -> None:
        if self.phase != "ready":
            raise DetectError("models_not_ready")

    def load_in_background(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._load_all, daemon=True)
        self._thread.start()

    def _load_all(self) -> None:
        try:
            for lang, repo in MODEL_IDS.items():
                self.detail = f"正在下载{'中文' if lang == 'zh' else '英文'}模型…"
                path = self._download(repo)
                self._load_one(lang, path)
                self.loaded[lang] = True
            self.phase = "ready"
            self.detail = "模型已就绪"
        except Exception as exc:
            self.phase = "error"
            self.detail = f"模型下载或加载失败：{exc}"

    def _download(self, repo_id: str) -> str:
        from huggingface_hub import snapshot_download

        try:
            return snapshot_download(repo_id=repo_id)
        except Exception:
            pass
        try:
            return snapshot_download(repo_id=repo_id, endpoint=HF_MIRROR)
        except Exception:
            pass
        from modelscope.hub.snapshot_download import snapshot_download as ms_download

        try:
            return ms_download(repo_id)
        except Exception:
            alt = "YuchuanTian/" + repo_id.split("/", 1)[-1]
            return ms_download(alt)

    def _load_one(self, lang: str, path: str) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        tok = AutoTokenizer.from_pretrained(path)
        model = AutoModelForSequenceClassification.from_pretrained(path)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model.to(device)
        model.eval()
        self._tokenizers[lang] = tok
        self._models[lang] = model
        self._ai_index[lang] = resolve_ai_index(model.config.id2label)

    def score(self, text: str, lang: str) -> float:
        self.assert_ready()
        model = self._models[lang]
        tok = self._tokenizers[lang]
        return score_paragraph(text, tok, model, self._ai_index[lang])
```

`backend/app/main.py`:

```python
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.errors import DetectError
from app.loader import ModelHub
from app.pipeline import run_detect

app = FastAPI(title="作文 AI 率查询")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
hub = ModelHub()


@app.on_event("startup")
def _startup() -> None:
    hub.load_in_background()


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


@app.post("/api/detect")
async def detect(request: Request):
    ctype = request.headers.get("content-type", "")
    file_bytes = None
    filename = None
    lang = None
    text = None
    if "multipart/form-data" in ctype:
        form = await request.form()
        lang = form.get("lang")
        upload = form.get("file")
        if upload is not None and hasattr(upload, "read"):
            file_bytes = await upload.read()
            filename = getattr(upload, "filename", None)
            if file_bytes == b"":
                file_bytes = None
    else:
        try:
            data = await request.json()
        except Exception as exc:
            raise DetectError("empty") from exc
        lang = data.get("lang")
        text = data.get("text")
    hub.assert_ready()
    return run_detect(lang, text, filename, file_bytes, hub.score)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_pipeline.py tests/test_api.py tests/test_aggregate.py tests/test_language.py -v
```

Expected: all passed. Adjust `test_pipeline` character weights if `count_chars` disagrees with the fixture (`H` + 200 `h` is 201 chars). Keep the test aligned with `count_chars`, do not change production weighting.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: add local detect API with status, rejects, and no cloud scoring`

---

### Task 10: Chinese frontend

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/vite-env.d.ts`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/api.ts`
- Create: `frontend/src/copy.ts`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/App.css`
- Create: `frontend/src/setupTests.ts`
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: backend `/api/status`, `/api/detect`
- Produces: single-page UI titled `作文 AI 率查询`

`canSubmit(lang, text, file)` is `false` when `lang` is null, or when there is no file and trimmed text is empty.

Verdict labels: `low` → `较低`, `uncertain` → `不确定`, `high` → `较高`. Confidence: `low` → `低`, `medium` → `中`, `high` → `高`.

If `file` is set, POST multipart `lang` + `file` and ignore textarea. Else POST JSON `{lang, text}`. Poll `/api/status` every 2s until `phase === "ready"` or `error`. Disable submit unless ready and `canSubmit`. Do not write `localStorage`. Copy button builds plain text including lang, model_id, score as one decimal percent, verdict, confidence, explanation, each paragraph excerpt and score.

Visual: off-white page `#f6f1e8`, ink `#1c1916`, accent `#3f5c4a` for primary button, `较高` uses `#8a4b2f` (not neon red). Serif title, sans body. No “降AI”“过检测” marketing.

- [ ] **Step 1: Write the failing test**

Scaffold Vite React TS with `npm create vite@latest frontend -- --template react-ts` if the folder is empty, then add test files. `frontend/src/copy.ts`:

Tests in `frontend/src/App.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { canSubmit } from "./copy";

describe("canSubmit", () => {
  it("blocks when language missing", () => {
    expect(canSubmit(null, "hello world", null)).toBe(false);
  });
  it("blocks when no file and empty text", () => {
    expect(canSubmit("zh", "  ", null)).toBe(false);
  });
  it("allows file without textarea", () => {
    expect(canSubmit("en", "", new File(["x"], "a.txt"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend
npm install
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
npx vitest run
```

Expected: FAIL until `copy.ts` exists.

- [ ] **Step 3: Write minimal implementation**

`frontend/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
```

`frontend/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
  },
});
```

`frontend/src/setupTests.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`frontend/src/types.ts`:

```ts
export type Lang = "zh" | "en";
export type Verdict = "low" | "uncertain" | "high";
export type Confidence = "low" | "medium" | "high";

export type DetectOk = {
  score: number;
  verdict: Verdict;
  confidence: Confidence;
  mixed_variance: boolean;
  char_count: number;
  word_count: number;
  model_id: string;
  lang: Lang;
  explanation: string;
  disclaimer: string;
  paragraphs: {
    index: number;
    excerpt: string;
    score: number;
    verdict: Verdict;
  }[];
};

export type DetectErr = { error: string; message: string };

export type Status = {
  phase: "downloading" | "ready" | "error";
  detail: string;
  models: { zh: boolean; en: boolean };
};
```

`frontend/src/copy.ts`:

```ts
import type { Confidence, DetectOk, Lang, Verdict } from "./types";

export function canSubmit(
  lang: Lang | null,
  text: string,
  file: File | null,
): boolean {
  if (!lang) return false;
  if (file) return true;
  return text.trim().length > 0;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  low: "较低",
  uncertain: "不确定",
  high: "较高",
};

export const CONF_LABEL: Record<Confidence, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export function formatResult(r: DetectOk): string {
  const lang = r.lang === "zh" ? "中文" : "英文";
  const lines = [
    `语言：${lang}`,
    `模型：${r.model_id}`,
    `总分：${(r.score * 100).toFixed(1)}%（${VERDICT_LABEL[r.verdict]}）`,
    `置信度：${CONF_LABEL[r.confidence]}`,
    r.explanation,
    r.disclaimer,
  ];
  if (r.mixed_variance) {
    lines.push("各段差异大，不宜只看一个总分。");
  }
  for (const p of r.paragraphs) {
    lines.push(
      `第${p.index + 1}段 ${(p.score * 100).toFixed(1)}% ${VERDICT_LABEL[p.verdict]}：${p.excerpt}`,
    );
  }
  return lines.join("\n");
}
```

`frontend/src/api.ts`:

```ts
import type { DetectErr, DetectOk, Lang, Status } from "./types";

export async function fetchStatus(): Promise<Status> {
  const r = await fetch("/api/status");
  if (!r.ok) throw new Error("status");
  return r.json();
}

export async function detect(args: {
  lang: Lang;
  text: string;
  file: File | null;
}): Promise<DetectOk | DetectErr> {
  let r: Response;
  if (args.file) {
    const fd = new FormData();
    fd.set("lang", args.lang);
    fd.set("file", args.file);
    r = await fetch("/api/detect", { method: "POST", body: fd });
  } else {
    r = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: args.lang, text: args.text }),
    });
  }
  const data = await r.json();
  return data as DetectOk | DetectErr;
}
```

`frontend/src/App.tsx` must implement the spec page: title `作文 AI 率查询`, always-visible disclaimer, language buttons, textarea, file input `accept=".txt,.docx"`, clear file, submit `开始检测`, status `detail`, result panel, copy button using `navigator.clipboard.writeText(formatResult(result))`. Poll status with `useEffect` + `setInterval` 2000ms. Show `请粘贴或上传` if user clicks submit when `!canSubmit` (button should already be disabled; keep disabled).

`frontend/src/App.css`: page background `#f6f1e8`, max width 760px, centered. Do not use purple-on-white generic AI-tool chrome.

`frontend/src/main.tsx` and `index.html` title: `作文 AI 率查询`.

`package.json` scripts: `"dev": "vite"`, `"build": "tsc -b && vite build"`, `"test": "vitest run"`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend
npx vitest run
```

Expected: canSubmit tests passed.

- [ ] **Step 5: Commit**

Skip unless asked. Message: `feat: add Chinese detect UI with language gate and paragraph results`

---

### Task 11: README and run path

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: ports and download behavior from earlier tasks
- Produces: a README a student can follow on Windows without guessing

- [ ] **Step 1: Write README.md** (no test file; verify by reading commands)

```markdown
# 作文 AI 率查询

本机网站：粘贴或上传中英文作文，用手选语言查看开源模型的 AI 倾向。第一版不做改写，也不对接知网 / Turnitin。

检测模型来自 [YuchuanTian/AIGC_text_detector](https://github.com/YuchuanTian/AIGC_text_detector)（Apache-2.0）。正文只在本机推理。第一次启动会下载几百 MB 权重：Hugging Face → hf-mirror.com → ModelScope，不会把作文传到第三方打分接口。

## 环境

- Python 3.11+
- Node.js 20+

## 启动

后端：

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

前端（另开一个终端）：

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5173

CPU 上较长学期论文会慢，请等页面提示模型就绪后再点检测。刷新页面不会保存历史。
```

- [ ] **Step 2: Confirm README paths match the repo** (`backend/requirements.txt`, `app.main:app`, frontend `npm run dev`).
- [ ] **Step 3: Run backend unit tests once more**

```bash
cd backend
python -m pytest -v
```

Expected: all passed.

- [ ] **Step 4: Commit**

Skip unless asked. Message: `docs: add local run instructions for the detector site`

---

## Spec coverage (self-review)

| Spec section | Task |
|--------------|------|
| Extract txt/docx, reject pdf | 2 |
| Length gates | 3 |
| Language mismatch | 4 |
| Paragraph split, no silent truncate | 5 |
| Weighted score, conservative verdict, mixed_variance | 6 |
| Explanation template | 7 |
| 512/256 windows, id2label | 8 |
| Download chain, no cloud score, API errors without score | 9 |
| Chinese UI, canSubmit, copy, no history | 10 |
| README, Python/Node versions | 11 |
| No rewrite / PDF / auto-lang / accounts | Global constraints (not implemented) |

## Placeholder scan

Commit steps are optional (user git rule). No extra routes, no cloud inference fallback, no PDF parser.

## Type consistency

- `ExtractedText.natural_paragraphs: tuple[str, ...] | None` used by extract → split → pipeline
- `DetectError.code` strings match API `error`
- `AggregateResult` fields match JSON keys in `run_detect`
- Frontend `DetectOk` matches that JSON
- `ModelHub.score(text, lang) -> float` is the `ScoreFn` passed into `run_detect`
