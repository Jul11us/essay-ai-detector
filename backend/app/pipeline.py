from __future__ import annotations

from collections.abc import Callable

from app.aggregate import aggregate
from app.errors import DISCLAIMER, DetectError
from app.explain import basis, explain, reading, review_outlook
from app.extract import ExtractedText, extract_from_bytes
from app.language import check_language
from app.length import check_length, count_chars
from app.markers import find_markers
from app.paragraphs import prepare_scoring_text, split_paragraphs
from app.rhythm import measure_rhythm
from app.scoring import MODEL_IDS

ScoreFn = Callable[[str, str], float]


def require_lang(lang: object) -> str:
    """在碰模型之前先校验语言，否则 `lang=fr` 会先撞上 models_not_ready 的 503。"""
    if lang not in {"zh", "en", "bi"}:
        raise DetectError("lang_required")
    return str(lang)


def run_detect(
    lang: str | None,
    text: str | None,
    filename: str | None,
    file_bytes: bytes | None,
    score_fn: ScoreFn,
    *,
    length_floor: int | None = None,
) -> dict:
    lang = require_lang(lang)
    if file_bytes is not None:
        extracted = extract_from_bytes(filename or "upload.bin", file_bytes)
    else:
        raw = (text or "").strip()
        if not raw:
            raise DetectError("empty")
        extracted = ExtractedText(text=raw, natural_paragraphs=None)
    scored_text, scored_natural, ignored = prepare_scoring_text(
        extracted.text, extracted.natural_paragraphs
    )
    check_length(scored_text, lang, floor=length_floor)
    check_language(scored_text, lang)
    parts = split_paragraphs(scored_text, lang, scored_natural)
    try:
        probs = [float(score_fn(p, lang)) for p in parts]
    except DetectError:
        raise
    except Exception as exc:
        raise DetectError("infer_failed") from exc
    agg = aggregate(parts, probs, lang)
    model_id = MODEL_IDS[lang]
    outlook = review_outlook(agg)
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
        "basis": basis(model_id, lang),
        "reading": reading(agg),
        "review_risk": outlook.risk,
        "review_label": outlook.label,
        "review": outlook.detail,
        "disclaimer": DISCLAIMER,
        "markers": find_markers(scored_text, lang),
        "rhythm": measure_rhythm(scored_text),
        "ignored": ignored,
        "paragraphs": [
            {
                "index": p.index,
                "excerpt": p.excerpt,
                "text": parts[p.index],
                "score": p.score,
                "verdict": p.verdict,
                "char_count": p.char_count,
            }
            for p in agg.paragraphs
        ],
    }


ScoreManyFn = Callable[[list[str], str], list[float]]

# 单句分数 = min(单独一句, 连同前后各一句)。
# 单独一句太短，模型方差大，人写的短句偶尔会被打到 0.9 以上；
# 带上下文的那一路在周围都是人写时会把它拉下来。反过来不行：模型只要
# 窗口里有一句明显的 AI 句就几乎给满分，取平均会把邻句的人写句子也染高。
# 所以上下文只用来「否决」，不用来「抬高」。实测（Vanguard，三段样本）：
#   人写短句 single=0.88 ctx=0.31 → 0.31；紧挨 AI 句的人写句 single=0.10 ctx=1.00 → 0.10；
#   AI 句 single=1.00 ctx=0.87 → 0.87。平均的话后者会把人写句抬到 0.55。


def _context_window(pieces: list[str], i: int, lang: str) -> str:
    joiner = "" if lang == "zh" else " "
    return joiner.join(pieces[max(0, i - 1) : i + 2])


def run_sentences(
    lang: str,
    text: str | None,
    score_fn: ScoreFn,
    score_many: ScoreManyFn | None = None,
) -> dict:
    """给一段做逐句打分。不走整篇的最短长度，方便学生改完一句就看。

    每句打两次：单独一句，以及连同前后各一句，取较低的那个。`score_many`
    一次把整段的句子成批送进模型；没给就退回逐条调用 `score_fn`。
    """
    from app.aggregate import paragraph_verdict
    from app.sentences import (
        MAX_SENTENCES,
        MIN_SENTENCE_CHARS,
        highlight_level,
        split_sentences,
    )

    if lang not in {"zh", "en"}:
        raise DetectError("lang_required")
    raw = (text or "").strip()
    if not raw:
        raise DetectError("empty")
    if count_chars(raw) > 8000:
        raise DetectError("too_long")
    pieces = split_sentences(raw)
    if not pieces:
        raise DetectError("empty")

    eligible = [i for i, piece in enumerate(pieces) if count_chars(piece) >= MIN_SENTENCE_CHARS]
    chosen = eligible[:MAX_SENTENCES]
    capped = len(eligible) > len(chosen)

    # 需要打分的文本去重：只有一句的段，「带上下文」就是它自己。
    queries: list[str] = []
    slot: dict[str, int] = {}
    pairs: dict[int, tuple[int, int]] = {}
    for i in chosen:
        keys = (pieces[i], _context_window(pieces, i, lang))
        ids = []
        for key in keys:
            if key not in slot:
                slot[key] = len(queries)
                queries.append(key)
            ids.append(slot[key])
        pairs[i] = (ids[0], ids[1])

    try:
        if score_many is not None:
            probs = [float(x) for x in score_many(queries, lang)]
        else:
            probs = [float(score_fn(q, lang)) for q in queries]
    except DetectError:
        raise
    except Exception as exc:
        raise DetectError("infer_failed") from exc
    if len(probs) != len(queries):
        raise DetectError("infer_failed")

    rows: list[dict] = []
    for i, piece in enumerate(pieces):
        if i not in pairs:
            rows.append({"text": piece, "score": None, "verdict": None, "highlight": None})
            continue
        single, ctx = pairs[i]
        prob = round(min(probs[single], probs[ctx]), 4)
        rows.append(
            {
                "text": piece,
                "score": prob,
                "verdict": paragraph_verdict(prob),
                "highlight": highlight_level(prob),
                "observations": find_markers(piece, lang),
            }
        )
    note = ""
    if capped:
        note = f"这一段只复核了前 {MAX_SENTENCES} 句，后面的句子没有单句分数。"
    return {"sentences": rows, "capped": capped, "note": note}
