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
    blob = a + "\n" + b + ("c" * 1200)
    parts = split_paragraphs(blob, "en")
    assert len(parts) >= 2



def test_scoring_text_excludes_front_matter_and_references():
    from app.paragraphs import prepare_scoring_text

    body = "The observations in this essay are grounded in a specific library visit. " * 5
    text = "A library afternoon\n\nCourse reflection\n\n" + body + "\n\nReferences\n\nSmith, J. Example."
    scored, natural, ignored = prepare_scoring_text(text)
    assert scored == body.strip()
    assert natural is None
    assert [item["reason"] for item in ignored] == [
        "标题或副标题", "标题或副标题", "参考文献", "参考文献",
    ]


def test_short_blocks_are_reported_as_excluded():
    from app.paragraphs import prepare_scoring_text

    body = "A careful observation of the local library can reveal several ordinary stories. " * 4
    scored, natural, ignored = prepare_scoring_text("Title\n\n" + body)
    assert scored == body.strip()
    assert natural is None
    assert ignored == [{"text": "Title", "reason": "标题或副标题"}]



def test_windows_crlf_does_not_fold_headings_into_body():
    from app.paragraphs import prepare_scoring_text

    body = "The writer describes a visit to a local library in ordinary detail. " * 5
    raw = "A Library Visit\r\n\r\n" + body + "\r\n\r\nReferences\r\n\r\nCitation"
    scored, _, ignored = prepare_scoring_text(raw)
    assert scored == body.strip()
    assert [item["reason"] for item in ignored] == [
        "标题或副标题", "参考文献", "参考文献",
    ]



def test_reference_heading_on_single_newline_still_excludes_tail():
    from app.paragraphs import prepare_scoring_text

    body = "The writer describes a visit to a local library in ordinary detail. " * 5
    raw = body + "\r\nReferences\r\nA sample citation."
    scored, _, ignored = prepare_scoring_text(raw)
    assert scored == body.strip()
    assert [item["reason"] for item in ignored] == ["参考文献", "参考文献"]
