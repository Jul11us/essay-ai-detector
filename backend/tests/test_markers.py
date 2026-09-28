from app.markers import find_markers


def test_english_phrases_do_not_double_count_longer_forms():
    text = "We delve into this pivotal topic. It is a testament to careful work."
    rows = {row["phrase"]: row["count"] for row in find_markers(text, "en")}
    assert rows["delve into"] == 1
    assert "delve" not in rows
    assert rows["pivotal"] == 1
    assert rows["a testament to"] == 1
    assert "testament to" not in rows


def test_not_only_pattern_occupies_the_inner_words():
    text = "This is not only clear but also useful."
    rows = {row["phrase"]: row["count"] for row in find_markers(text, "en")}
    assert rows["not only … but also"] == 1
    assert "not only" not in rows
    assert "but also" not in rows


def test_word_boundary_skips_longer_english_words():
    text = "This is crucially different, and it is crucial."
    rows = {row["phrase"]: row["count"] for row in find_markers(text, "en")}
    assert rows == {"crucial": 1}


def test_chinese_frame_and_cliche():
    text = "综上所述，这不仅是进步，而且具有重要里程碑意义。"
    rows = {row["phrase"]: row["count"] for row in find_markers(text, "zh")}
    assert rows["综上所述"] == 1
    assert rows["不仅……而且"] == 1
    assert rows["具有重要里程碑意义"] == 1
    assert "不仅" not in rows
    assert "而且" not in rows
    assert "里程碑" not in rows


def test_no_hits_is_empty():
    assert find_markers("The cat sat on the mat.", "en") == []
