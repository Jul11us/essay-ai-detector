import hashlib
import json
from pathlib import Path

import httpx
import pytest

from app.evaluation_stats import make_records, summarize
from benchmark import load_checkpoint, load_manifest, main, run_api, wait_for_models


def test_counts_false_flags_and_misses_without_treating_mixed_as_binary():
    rows = [
        {"id": "h", "lang": "en", "label": "human", "source": "test", "writer_group": "non_native"},
        {"id": "a", "lang": "en", "label": "ai", "source": "test"},
        {"id": "m", "lang": "zh", "label": "mixed", "source": "test"},
    ]
    predictions = [
        {
            "id": "h",
            "score": 0.8,
            "verdict": "high",
            "confidence": "high",
            "char_count": 1600,
            "word_count": 300,
            "latency_ms": 10,
        },
        {
            "id": "a",
            "score": 0.1,
            "verdict": "low",
            "confidence": "low",
            "char_count": 399,
            "word_count": 70,
            "latency_ms": 20,
        },
        {
            "id": "m",
            "score": 0.5,
            "verdict": "uncertain",
            "confidence": "medium",
            "char_count": 500,
            "word_count": 1,
            "latency_ms": 30,
        },
    ]
    report = summarize(rows, predictions)
    assert report["overall"]["human_high_false_flag"]["count"] == 1
    assert report["overall"]["human_high_false_flag"]["of"] == 1
    assert report["overall"]["ai_low_miss"]["rate"] == 1
    assert report["overall"]["mixed"] == {"uncertain": 1}
    assert report["groups"]["writer_group:non_native"]["n"] == 1
    assert (
        report["groups"]["lang:en|length:under_400_chars"]["confidence_insufficient"]["count"] == 1
    )
    assert report["overall"]["confidence_insufficient"]["of"] == 3
    assert report["latency"]["n"] == 3 and report["latency"]["mean_ms"] == 20
    assert report["latency"]["median_ms"] == 20 and report["latency"]["p95_ms"] == 30
    assert report["records"][0]["confidence_sufficient"] is True
    assert report["records"][1]["confidence_sufficient"] is False


def test_manifest_requires_provenance_and_local_file(tmp_path: Path):
    (tmp_path / "essay.txt").write_text("sample", encoding="utf-8")
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        '{"id":"one","file":"essay.txt","lang":"en","label":"human"}\n', encoding="utf-8"
    )
    with pytest.raises(ValueError, match="source"):
        load_manifest(manifest)
    manifest.write_text(
        '{"id":"one","file":"../elsewhere.txt","lang":"en","label":"human","source":"test"}\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="manifest directory"):
        load_manifest(manifest)


def _manifest(tmp_path, rows):
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return manifest


def _row(id, file, split="calibration", group=None):
    return {
        "id": id,
        "file": file,
        "lang": "en",
        "label": "human",
        "source": "public dataset",
        "group_id": group or id,
        "split": split,
    }


def test_manifest_blocks_original_versions_across_splits(tmp_path):
    (tmp_path / "h.txt").write_text("human", encoding="utf-8")
    (tmp_path / "a.txt").write_text("generated", encoding="utf-8")
    with pytest.raises(ValueError, match="Group leakage"):
        load_manifest(
            _manifest(
                tmp_path,
                [_row("h", "h.txt", group="original"), _row("a", "a.txt", "test", "original")],
            )
        )


def test_manifest_blocks_identical_content_even_with_different_group_ids(tmp_path):
    (tmp_path / "h.txt").write_text("same content", encoding="utf-8")
    (tmp_path / "a.txt").write_text("same content", encoding="utf-8")
    with pytest.raises(ValueError, match="Identical input content"):
        load_manifest(_manifest(tmp_path, [_row("h", "h.txt"), _row("a", "a.txt", "test")]))
    with pytest.raises(ValueError, match="inflate"):
        load_manifest(_manifest(tmp_path, [_row("h", "h.txt"), _row("a", "a.txt")]))


def test_manifest_text_hash_and_source_metadata(tmp_path):
    data = b"human source text"
    (tmp_path / "h.txt").write_bytes(data)
    row = {
        **_row("h", "h.txt"),
        "text_sha256": hashlib.sha256(data).hexdigest(),
        "source_url": "https://example.org/dataset",
        "license": "CC-BY-SA-4.0",
    }
    assert load_manifest(_manifest(tmp_path, [row]))[0]["_sha256"] == row["text_sha256"]
    with pytest.raises(ValueError, match="sha256 mismatch"):
        load_manifest(_manifest(tmp_path, [{**row, "text_sha256": "invalid"}]))
    with pytest.raises(ValueError, match="public HTTP"):
        load_manifest(_manifest(tmp_path, [{**row, "source_url": "file:///private/path"}]))


@pytest.mark.parametrize("score", [True, False, float("nan"), float("inf"), -0.1, 1.01, "0.5"])
def test_predictions_reject_nonfinite_boolean_and_out_of_range_scores(score):
    row = {"id": "h", "lang": "en", "label": "human", "source": "test"}
    with pytest.raises(ValueError):
        summarize([row], [{"id": "h", "score": score, "verdict": "uncertain"}])


@pytest.mark.parametrize(
    "predictions",
    [
        [],
        [{"id": "other", "score": 0.5, "verdict": "uncertain"}],
        [{"id": "h", "score": 0.5, "verdict": "uncertain"}] * 2,
    ],
)
def test_predictions_require_exactly_one_per_manifest_id(predictions):
    with pytest.raises(ValueError, match="exactly one"):
        summarize([{"id": "h", "lang": "en", "label": "human", "source": "test"}], predictions)


@pytest.mark.parametrize(
    "key,value",
    [
        ("char_count", True),
        ("word_count", -1),
        ("latency_ms", float("nan")),
        ("confidence", "probability"),
        ("model_id", None),
    ],
)
def test_predictions_validate_metadata(key, value):
    with pytest.raises(ValueError):
        make_records(
            [{"id": "h", "lang": "en", "label": "human", "source": "test"}],
            [{"id": "h", "score": 0.5, "verdict": "uncertain", key: value}],
        )


def test_report_uses_allowlist_without_essay_text_or_input_paths():
    rows = [
        {
            "id": "h",
            "lang": "en",
            "label": "human",
            "source": "public source",
            "file": "private-file.txt",
            "_path": Path("C:/private/input.txt"),
        }
    ]
    predictions = [
        {
            "id": "h",
            "score": 0.5,
            "verdict": "uncertain",
            "text": "SECRET TEXT",
            "paragraphs": [{"text": "SECRET TEXT"}],
            "explanation": "private detail",
        }
    ]
    serialized = json.dumps(summarize(rows, predictions))
    assert (
        "SECRET TEXT" not in serialized
        and "private/input" not in serialized
        and "private-file" not in serialized
    )


def test_api_calls_exact_endpoint_and_saves_safe_metadata(tmp_path, monkeypatch):
    data = b"sample essay"
    file = tmp_path / "essay.txt"
    file.write_bytes(data)
    seen = []
    real_client = httpx.Client

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "score": 0.5,
                "verdict": "uncertain",
                "model_id": "model",
                "model_revision": "revision",
                "char_count": 100,
                "word_count": 20,
                "confidence": "low",
                "paragraphs": [{"text": "essay body"}],
            },
        )

    monkeypatch.setattr(
        "httpx.Client",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )
    predictions = run_api([{"id": "h", "lang": "en", "_path": file}], "http://127.0.0.1:8000")
    assert seen[0].url.path == "/api/detect" and data in seen[0].content
    assert predictions[0]["model_revision"] == "revision"
    assert predictions[0]["api_pipeline"] == "/api/detect" and predictions[0]["latency_ms"] >= 0
    assert "paragraphs" not in predictions[0]


def test_api_failure_does_not_echo_response_or_exception(tmp_path, monkeypatch):
    file = tmp_path / "essay.txt"
    file.write_text("sample", encoding="utf-8")
    real_client = httpx.Client
    monkeypatch.setattr(
        "httpx.Client",
        lambda **kwargs: real_client(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(500, text="SECRET TEXT C:/private/essay.txt")
            ),
            **kwargs,
        ),
    )
    with pytest.raises(RuntimeError) as error:
        run_api([{"id": "h", "lang": "en", "_path": file}], "http://localhost:8000")
    assert str(error.value) == "h: API HTTP 500"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://example.com",
        "http://127.0.0.1.example.com",
        "http://user:pass@127.0.0.1",
    ],
)
def test_api_rejects_nonlocal_hosts_and_credentials(url):
    with pytest.raises(ValueError, match="local HTTP"):
        run_api([], url)


def test_cli_prediction_replay_preserves_metadata_and_exports_only_safe_fields(
    tmp_path, monkeypatch
):
    (tmp_path / "essay.txt").write_text("sample essay", encoding="utf-8")
    manifest = _manifest(
        tmp_path,
        [
            {
                "id": "h",
                "file": "essay.txt",
                "lang": "en",
                "label": "human",
                "source": "public source",
            }
        ],
    )
    predictions = tmp_path / "input.jsonl"
    predictions.write_text(
        json.dumps(
            {
                "id": "h",
                "score": 0.5,
                "verdict": "uncertain",
                "model_id": "model",
                "model_revision": "revision",
                "confidence": "low",
                "char_count": 100,
                "word_count": 20,
                "latency_ms": 10,
                "text": "SECRET",
                "_path": "C:/private/essay.txt",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    report_out, predictions_out = tmp_path / "report.json", tmp_path / "predictions.jsonl"
    monkeypatch.setattr(
        "sys.argv",
        [
            "benchmark.py",
            str(manifest),
            "--predictions",
            str(predictions),
            "--out",
            str(report_out),
            "--predictions-out",
            str(predictions_out),
        ],
    )
    main()
    output = predictions_out.read_text(encoding="utf-8")
    assert "SECRET" not in output and "C:/private" not in output
    assert (
        json.loads(output)["model_revision"] == "revision"
        and json.loads(output)["latency_ms"] == 10
    )
    assert json.loads(report_out.read_text(encoding="utf-8"))["overall"]["n"] == 1


# ---- 续跑与等待模型 ----


def _api_rows(tmp_path, n=3):
    rows = []
    for i in range(n):
        path = tmp_path / f"e{i}.txt"
        path.write_text(f"essay {i}", encoding="utf-8")
        rows.append({"id": f"s{i}", "lang": "en", "_path": path})
    return rows


def _ok(revision="rev-1"):
    return httpx.Response(
        200,
        json={
            "score": 0.3,
            "verdict": "low",
            "model_id": "model",
            "model_revision": revision,
            "char_count": 900,
            "word_count": 150,
            "confidence": "medium",
        },
    )


_REAL_CLIENT = httpx.Client  # 先存下来：同一个用例里可能要换两次 handler


def _patch_client(monkeypatch, handler):
    monkeypatch.setattr(
        "httpx.Client",
        lambda **kwargs: _REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs),
    )


def test_failed_run_keeps_progress_and_resume_scores_only_the_rest(tmp_path, monkeypatch):
    rows = _api_rows(tmp_path)
    checkpoint = tmp_path / "out" / "predictions.jsonl"
    calls = []

    def flaky(request):
        calls.append(request)
        return _ok() if len(calls) == 1 else httpx.Response(400, json={"error": "x"})

    _patch_client(monkeypatch, flaky)
    with pytest.raises(RuntimeError, match="s1: API HTTP 400"):
        run_api(rows, "http://127.0.0.1:8000", checkpoint=checkpoint)
    saved = [json.loads(line) for line in checkpoint.read_text(encoding="utf-8").splitlines()]
    assert [p["id"] for p in saved] == ["s0"]

    calls.clear()
    _patch_client(monkeypatch, lambda request: calls.append(request) or _ok())
    predictions = run_api(rows, "http://127.0.0.1:8000", checkpoint=checkpoint)
    assert len(calls) == 2  # s0 不再重算
    assert [p["id"] for p in predictions] == ["s0", "s1", "s2"]
    lines = checkpoint.read_text(encoding="utf-8").splitlines()
    assert sorted(json.loads(line)["id"] for line in lines) == ["s0", "s1", "s2"]


def test_resume_refuses_a_different_model_revision(tmp_path, monkeypatch):
    rows = _api_rows(tmp_path, 2)
    checkpoint = tmp_path / "predictions.jsonl"
    _patch_client(monkeypatch, lambda request: _ok("rev-1"))
    run_api(rows[:1], "http://127.0.0.1:8000", checkpoint=checkpoint)
    _patch_client(monkeypatch, lambda request: _ok("rev-2"))
    with pytest.raises(RuntimeError, match="differs from the one in the checkpoint"):
        run_api(rows, "http://127.0.0.1:8000", checkpoint=checkpoint)


def test_checkpoint_drops_only_a_cut_off_last_line(tmp_path):
    rows = _api_rows(tmp_path, 3)
    good = json.dumps({"id": "s0", "score": 0.2, "verdict": "low"})
    path = tmp_path / "predictions.jsonl"
    path.write_text(good + '\n{"id": "s1", "sco', encoding="utf-8")
    assert [p["id"] for p in load_checkpoint(path, rows)] == ["s0"]
    path.write_text('{"id": "s1", "sco\n' + good + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        load_checkpoint(path, rows)
    path.write_text(json.dumps({"id": "other", "score": 0.2}) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="does not belong"):
        load_checkpoint(path, rows)
    path.write_text(good + "\n" + good + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        load_checkpoint(path, rows)


def test_cli_will_not_overwrite_saved_predictions_without_resume(tmp_path, monkeypatch):
    (tmp_path / "essay.txt").write_text("sample essay", encoding="utf-8")
    manifest = _manifest(
        tmp_path,
        [{"id": "h", "file": "essay.txt", "lang": "en", "label": "human", "source": "s"}],
    )
    saved = tmp_path / "predictions.jsonl"
    saved.write_text('{"id": "h", "score": 0.1, "verdict": "low"}\n', encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv",
        [
            "benchmark.py",
            str(manifest),
            "--predictions-out",
            str(saved),
            "--out",
            str(tmp_path / "report.json"),
        ],
    )
    with pytest.raises(SystemExit):
        main()
    assert saved.read_text(encoding="utf-8") == '{"id": "h", "score": 0.1, "verdict": "low"}\n'


def test_wait_for_models_polls_until_the_needed_languages_load(monkeypatch):
    states = iter(
        [
            {"models": {"en": False, "zh": False}, "loading": True},
            {"models": {"en": True, "zh": False}, "loading": True},
            {"models": {"en": True, "zh": True}, "loading": False},
        ]
    )
    calls = []
    _patch_client(
        monkeypatch, lambda request: calls.append(request) or httpx.Response(200, json=next(states))
    )
    monkeypatch.setattr("time.sleep", lambda s: None)
    wait_for_models("http://127.0.0.1:8000", {"en", "zh"}, timeout_s=60)
    assert len(calls) == 3 and calls[0].url.path == "/api/status"


def test_wait_for_models_fails_fast_when_loading_ended_without_a_model(monkeypatch):
    _patch_client(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"models": {"en": True, "zh": False}, "loading": False}
        ),
    )
    monkeypatch.setattr("time.sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="Model not available for: zh"):
        wait_for_models("http://127.0.0.1:8000", {"en", "zh"}, timeout_s=60)


def test_wait_for_models_times_out(monkeypatch):
    _patch_client(
        monkeypatch,
        lambda request: httpx.Response(200, json={"models": {"en": False}, "loading": True}),
    )
    clock = iter([0.0, 0.0, 5.0, 11.0, 20.0])
    monkeypatch.setattr("time.monotonic", lambda: next(clock))
    monkeypatch.setattr("time.sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="still not ready after 10s: en"):
        wait_for_models("http://127.0.0.1:8000", {"en"}, timeout_s=10)


def test_api_error_shows_only_our_fixed_error_code(tmp_path, monkeypatch):
    rows = _api_rows(tmp_path, 1)
    _patch_client(
        monkeypatch,
        lambda request: httpx.Response(
            400, json={"error": "too_short", "message": "SECRET essay text"}
        ),
    )
    with pytest.raises(RuntimeError) as error:
        run_api(rows, "http://127.0.0.1:8000")
    assert str(error.value) == "s0: API HTTP 400 (too_short)"
    _patch_client(
        monkeypatch,
        lambda request: httpx.Response(400, json={"error": "Contains SECRET text!"}),
    )
    with pytest.raises(RuntimeError) as error:
        run_api(rows, "http://127.0.0.1:8000")
    assert str(error.value) == "s0: API HTTP 400"


def test_cli_stop_prints_how_many_were_saved_and_how_to_resume(tmp_path, monkeypatch, capsys):
    (tmp_path / "a.txt").write_text("first essay", encoding="utf-8")
    (tmp_path / "b.txt").write_text("second essay", encoding="utf-8")
    manifest = _manifest(
        tmp_path,
        [
            {"id": "a", "file": "a.txt", "lang": "en", "label": "human", "source": "s"},
            {"id": "b", "file": "b.txt", "lang": "en", "label": "ai", "source": "s"},
        ],
    )
    calls = []
    _patch_client(
        monkeypatch,
        lambda request: calls.append(1) or (_ok() if len(calls) == 1 else httpx.Response(503)),
    )
    saved = tmp_path / "predictions.jsonl"
    monkeypatch.setattr(
        "sys.argv",
        [
            "benchmark.py",
            str(manifest),
            "--predictions-out",
            str(saved),
            "--out",
            str(tmp_path / "report.json"),
        ],
    )
    with pytest.raises(SystemExit) as stop:
        main()
    message = str(stop.value)
    assert message.startswith("Stopped: b: API HTTP 503")
    assert "1 predictions are saved" in message and "--resume" in message


def test_missing_model_revision_is_recorded_as_unknown_so_the_report_still_builds(
    tmp_path, monkeypatch
):
    rows = _api_rows(tmp_path, 1)
    response = _ok().json() | {"model_revision": None}
    _patch_client(monkeypatch, lambda request: httpx.Response(200, json=response))
    checkpoint = tmp_path / "predictions.jsonl"
    predictions = run_api(rows, "http://127.0.0.1:8000", checkpoint=checkpoint)
    assert predictions[0]["model_revision"] == "unknown"
    # 旧版本写下的 null 也能续用
    checkpoint.write_text(
        json.dumps({"id": "s0", "score": 0.3, "verdict": "low", "model_revision": None}) + "\n",
        encoding="utf-8",
    )
    assert load_checkpoint(checkpoint, rows)[0]["model_revision"] == "unknown"
    report = summarize([{"id": "s0", "lang": "en", "label": "human", "source": "s"}], predictions)
    assert report["records"][0]["model_revision"] == "unknown"


def test_ctrl_c_keeps_progress_and_says_how_to_resume(tmp_path, monkeypatch):
    for name in ("a", "b"):
        (tmp_path / f"{name}.txt").write_text(f"essay {name}", encoding="utf-8")
    manifest = _manifest(
        tmp_path,
        [
            {"id": "a", "file": "a.txt", "lang": "en", "label": "human", "source": "s"},
            {"id": "b", "file": "b.txt", "lang": "en", "label": "ai", "source": "s"},
        ],
    )
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 2:
            raise KeyboardInterrupt
        return _ok()

    _patch_client(monkeypatch, handler)
    saved = tmp_path / "predictions.jsonl"
    monkeypatch.setattr(
        "sys.argv",
        [
            "benchmark.py",
            str(manifest),
            "--predictions-out",
            str(saved),
            "--out",
            str(tmp_path / "report.json"),
        ],
    )
    with pytest.raises(SystemExit) as stop:
        main()
    assert str(stop.value).startswith("Stopped: interrupted (Ctrl-C)")
    assert "1 predictions are saved" in str(stop.value)
    assert [json.loads(line)["id"] for line in saved.read_text().splitlines()] == ["a"]
