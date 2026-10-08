import hashlib
import json
from pathlib import Path

import httpx
import pytest

from app.evaluation_stats import make_records, summarize
from benchmark import load_manifest, main, run_api


def test_counts_false_flags_and_misses_without_treating_mixed_as_binary():
    rows = [
        {"id": "h", "lang": "en", "label": "human", "source": "test", "writer_group": "non_native"},
        {"id": "a", "lang": "en", "label": "ai", "source": "test"},
        {"id": "m", "lang": "zh", "label": "mixed", "source": "test"},
    ]
    predictions = [
        {"id": "h", "score": 0.8, "verdict": "high", "confidence": "high", "char_count": 1600, "word_count": 300, "latency_ms": 10},
        {"id": "a", "score": 0.1, "verdict": "low", "confidence": "low", "char_count": 399, "word_count": 70, "latency_ms": 20},
        {"id": "m", "score": 0.5, "verdict": "uncertain", "confidence": "medium", "char_count": 500, "word_count": 1, "latency_ms": 30},
    ]
    report = summarize(rows, predictions)
    assert report["overall"]["human_high_false_flag"]["count"] == 1
    assert report["overall"]["human_high_false_flag"]["of"] == 1
    assert report["overall"]["ai_low_miss"]["rate"] == 1
    assert report["overall"]["mixed"] == {"uncertain": 1}
    assert report["groups"]["writer_group:non_native"]["n"] == 1
    assert report["groups"]["lang:en|length:under_400_chars"]["confidence_insufficient"]["count"] == 1
    assert report["overall"]["confidence_insufficient"]["of"] == 3
    assert report["latency"]["n"] == 3 and report["latency"]["mean_ms"] == 20
    assert report["latency"]["median_ms"] == 20 and report["latency"]["p95_ms"] == 30
    assert report["records"][0]["confidence_sufficient"] is True
    assert report["records"][1]["confidence_sufficient"] is False


def test_manifest_requires_provenance_and_local_file(tmp_path: Path):
    (tmp_path / "essay.txt").write_text("sample", encoding="utf-8")
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text('{"id":"one","file":"essay.txt","lang":"en","label":"human"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="source"):
        load_manifest(manifest)
    manifest.write_text('{"id":"one","file":"../elsewhere.txt","lang":"en","label":"human","source":"test"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="manifest directory"):
        load_manifest(manifest)


def _manifest(tmp_path, rows):
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return manifest


def _row(id, file, split="calibration", group=None):
    return {"id": id, "file": file, "lang": "en", "label": "human", "source": "public dataset", "group_id": group or id, "split": split}


def test_manifest_blocks_original_versions_across_splits(tmp_path):
    (tmp_path / "h.txt").write_text("human", encoding="utf-8")
    (tmp_path / "a.txt").write_text("generated", encoding="utf-8")
    with pytest.raises(ValueError, match="Group leakage"):
        load_manifest(_manifest(tmp_path, [_row("h", "h.txt", group="original"), _row("a", "a.txt", "test", "original")]))


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
    row = {**_row("h", "h.txt"), "text_sha256": hashlib.sha256(data).hexdigest(), "source_url": "https://example.org/dataset", "license": "CC-BY-SA-4.0"}
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


@pytest.mark.parametrize("predictions", [[], [{"id": "other", "score": .5, "verdict": "uncertain"}], [{"id": "h", "score": .5, "verdict": "uncertain"}] * 2])
def test_predictions_require_exactly_one_per_manifest_id(predictions):
    with pytest.raises(ValueError, match="exactly one"):
        summarize([{"id": "h", "lang": "en", "label": "human", "source": "test"}], predictions)


@pytest.mark.parametrize("key,value", [("char_count", True), ("word_count", -1), ("latency_ms", float("nan")), ("confidence", "probability"), ("model_id", None)])
def test_predictions_validate_metadata(key, value):
    with pytest.raises(ValueError):
        make_records([{"id": "h", "lang": "en", "label": "human", "source": "test"}], [{"id": "h", "score": .5, "verdict": "uncertain", key: value}])


def test_report_uses_allowlist_without_essay_text_or_input_paths():
    rows = [{"id": "h", "lang": "en", "label": "human", "source": "public source", "file": "private-file.txt", "_path": Path("C:/private/input.txt")}]
    predictions = [{"id": "h", "score": .5, "verdict": "uncertain", "text": "SECRET TEXT", "paragraphs": [{"text": "SECRET TEXT"}], "explanation": "private detail"}]
    serialized = json.dumps(summarize(rows, predictions))
    assert "SECRET TEXT" not in serialized and "private/input" not in serialized and "private-file" not in serialized


def test_api_calls_exact_endpoint_and_saves_safe_metadata(tmp_path, monkeypatch):
    data = b"sample essay"
    file = tmp_path / "essay.txt"
    file.write_bytes(data)
    seen = []
    real_client = httpx.Client
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"score": .5, "verdict": "uncertain", "model_id": "model", "model_revision": "revision", "char_count": 100, "word_count": 20, "confidence": "low", "paragraphs": [{"text": "essay body"}]})
    monkeypatch.setattr("httpx.Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    predictions = run_api([{"id": "h", "lang": "en", "_path": file}], "http://127.0.0.1:8000")
    assert seen[0].url.path == "/api/detect" and data in seen[0].content
    assert predictions[0]["model_revision"] == "revision"
    assert predictions[0]["api_pipeline"] == "/api/detect" and predictions[0]["latency_ms"] >= 0
    assert "paragraphs" not in predictions[0]


def test_api_failure_does_not_echo_response_or_exception(tmp_path, monkeypatch):
    file = tmp_path / "essay.txt"
    file.write_text("sample", encoding="utf-8")
    real_client = httpx.Client
    monkeypatch.setattr("httpx.Client", lambda **kwargs: real_client(transport=httpx.MockTransport(lambda r: httpx.Response(500, text="SECRET TEXT C:/private/essay.txt")), **kwargs))
    with pytest.raises(RuntimeError) as error:
        run_api([{"id": "h", "lang": "en", "_path": file}], "http://localhost:8000")
    assert str(error.value) == "h: API HTTP 500"


@pytest.mark.parametrize("url", ["https://example.com", "http://example.com", "http://127.0.0.1.example.com", "http://user:pass@127.0.0.1"])
def test_api_rejects_nonlocal_hosts_and_credentials(url):
    with pytest.raises(ValueError, match="local HTTP"):
        run_api([], url)


def test_cli_prediction_replay_preserves_metadata_and_exports_only_safe_fields(tmp_path, monkeypatch):
    (tmp_path / "essay.txt").write_text("sample essay", encoding="utf-8")
    manifest = _manifest(tmp_path, [{"id": "h", "file": "essay.txt", "lang": "en", "label": "human", "source": "public source"}])
    predictions = tmp_path / "input.jsonl"
    predictions.write_text(json.dumps({"id": "h", "score": .5, "verdict": "uncertain", "model_id": "model", "model_revision": "revision", "confidence": "low", "char_count": 100, "word_count": 20, "latency_ms": 10, "text": "SECRET", "_path": "C:/private/essay.txt"}) + "\n", encoding="utf-8")
    report_out, predictions_out = tmp_path / "report.json", tmp_path / "predictions.jsonl"
    monkeypatch.setattr("sys.argv", ["benchmark.py", str(manifest), "--predictions", str(predictions), "--out", str(report_out), "--predictions-out", str(predictions_out)])
    main()
    output = predictions_out.read_text(encoding="utf-8")
    assert "SECRET" not in output and "C:/private" not in output
    assert json.loads(output)["model_revision"] == "revision" and json.loads(output)["latency_ms"] == 10
    assert json.loads(report_out.read_text(encoding="utf-8"))["overall"]["n"] == 1
