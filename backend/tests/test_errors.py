from app.errors import DISCLAIMER, HTTP_STATUS, DetectError, MESSAGES


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


def test_bad_request_is_400():
    err = DetectError("bad_request")
    assert err.http_status == 400
    assert err.message == MESSAGES["bad_request"]


def test_payload_too_large_is_400_and_mentions_the_limit():
    err = DetectError("payload_too_large")
    assert err.http_status == 400
    assert "20 MB" in err.message


def test_every_message_code_has_an_http_status():
    assert set(MESSAGES) == set(HTTP_STATUS)


def test_disclaimer_is_exact():
    assert DISCLAIMER == "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。"
