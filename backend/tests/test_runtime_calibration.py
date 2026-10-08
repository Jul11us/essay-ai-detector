"""Only verified, matching document profiles may change document display bands."""
from copy import deepcopy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import calibration
from app.scoring import MODEL_IDS
from app.calibration_fit import wilson_interval

REVISION = "sha256:" + "a" * 64


@pytest.fixture(autouse=True)
def isolate_profile_env(monkeypatch):
    monkeypatch.delenv("DETECTOR_CALIBRATION_PATH", raising=False)
    calibration._read_profile.cache_clear()
    yield
    calibration._read_profile.cache_clear()


def valid_profile():
    # Synthetic aggregate evidence, no real sample texts or model weights.
    counts = {"human": 40, "ai": 40, "mixed": 0, "groups": 40,
              "groups_by_label": {"human": 40, "ai": 40, "mixed": 0}}
    error_rate = {"count": 0, "of": 40, "rate": 0.0, "wilson_ci": wilson_interval(0, 40)}
    metrics = {"human_high_false_flag": deepcopy(error_rate), "ai_low_miss": deepcopy(error_rate)}
    return {
        "schema_version": 1, "evaluation_unit": "document",
        "profile_version": "test-v1", "dataset_fingerprint": "b" * 64,
        "score_semantics": "raw_model_score_not_authorship_probability",
        "policy": {"max_false_positive_rate": 0.20, "max_false_negative_rate": 0.20,
                   "confidence_level": 0.95, "min_samples_per_class": 30},
        "languages": {
            "en": {
                "status": "validated", "model_id": MODEL_IDS["en"], "model_revision": REVISION,
                "reasons": [],
                "training_overlap": {"status": "excluded", "evidence": ["Synthetic fixture only; not a real calibration result."]},
                "low": 0.20, "high": 0.60,
                "applicability": {"char_count": {"min": 200, "max": 2000},
                                  "evaluation_unit": "document", "source_scope": "synthetic test fixture",
                                  "writer_groups": ["synthetic_unknown_author"], "source_domains": ["synthetic"]},
                "counts": {"calibration": deepcopy(counts), "test": deepcopy(counts)},
                "calibration_metrics": deepcopy(metrics), "test_metrics": deepcopy(metrics),
            },
        },
    }


def install_profile(tmp_path: Path, monkeypatch, profile=None):
    path = tmp_path / "threshold-profile.json"
    path.write_text(json.dumps(valid_profile() if profile is None else profile), encoding="utf-8")
    monkeypatch.setenv("DETECTOR_CALIBRATION_PATH", str(path))
    return path


def resolve(revision=REVISION, count=500, scope="document"):
    return calibration.resolve_calibration("en", MODEL_IDS["en"], revision, count, scope=scope)


def assert_defaults(result):
    assert result["applied"] is False
    assert result["low"] == calibration.DEFAULT_LOW
    assert result["high"] == calibration.DEFAULT_HIGH


def test_default_without_profile_and_missing_profile_path(tmp_path, monkeypatch):
    assert_defaults(resolve())
    monkeypatch.setenv("DETECTOR_CALIBRATION_PATH", str(tmp_path / "missing.json"))
    result = resolve()
    assert_defaults(result)
    assert result["status"] == "unvalidated"


@pytest.mark.parametrize("status", ["candidate", "unvalidated"])
def test_candidate_never_enables_thresholds(tmp_path, monkeypatch, status):
    profile = valid_profile()
    profile["languages"]["en"]["status"] = status
    install_profile(tmp_path, monkeypatch, profile)
    result = resolve()
    assert_defaults(result)
    assert result["status"] == status


@pytest.mark.parametrize("revision", [None, "", "unknown", "sha256:" + "c" * 64])
def test_unknown_or_different_runtime_revision_falls_back(tmp_path, monkeypatch, revision):
    install_profile(tmp_path, monkeypatch)
    result = resolve(revision=revision)
    assert_defaults(result)
    assert result["status"] == "unvalidated"


def test_matching_unknown_revision_cannot_claim_validation(tmp_path, monkeypatch):
    profile = valid_profile()
    profile["languages"]["en"]["model_revision"] = "unknown"
    install_profile(tmp_path, monkeypatch, profile)
    assert_defaults(resolve(revision="unknown"))


@pytest.mark.parametrize("change", [
    lambda p: p.pop("schema_version"),
    lambda p: p.update(schema_version=2),
    lambda p: p.update(schema_version=True),
    lambda p: p.update(evaluation_unit="paragraph"),
    lambda p: p.update(languages=[]),
    lambda p: p["languages"]["en"].update(status="anything"),
    lambda p: p["languages"]["en"].update(low=True),
    lambda p: p["languages"]["en"].update(low=0.8, high=0.6),
    lambda p: p["languages"]["en"].update(low=float("nan")),
    lambda p: p["languages"]["en"].update(high=float("inf")),
    lambda p: p.update(profile_version=float("nan")),
    lambda p: p["languages"]["en"].update(applicability={"char_count": {"min": True, "max": 2000}}),
])
def test_invalid_schema_thresholds_or_extent_fail_closed(tmp_path, monkeypatch, change):
    profile = deepcopy(valid_profile())
    change(profile)
    install_profile(tmp_path, monkeypatch, profile)
    result = resolve()
    assert_defaults(result)
    assert result["status"] == "unvalidated"


@pytest.mark.parametrize("body", ["[", "[]", " " * (2 * 1024 * 1024 + 1)], ids=["invalid-json", "array", "oversized"])
def test_malformed_or_oversized_profile_falls_back(tmp_path, monkeypatch, body):
    path = tmp_path / "invalid.json"
    path.write_text(body, encoding="utf-8")
    monkeypatch.setenv("DETECTOR_CALIBRATION_PATH", str(path))
    assert_defaults(resolve())


def test_json_float_overflow_cannot_leak_into_api_metadata(tmp_path, monkeypatch):
    path = tmp_path / "overflow.json"
    body = json.dumps(valid_profile()).replace('"profile_version": "test-v1"', '"profile_version": 1e999')
    path.write_text(body, encoding="utf-8")
    monkeypatch.setenv("DETECTOR_CALIBRATION_PATH", str(path))
    assert_defaults(resolve())


def test_excessive_json_nesting_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "deep.json"
    path.write_text("[" * 2000 + "0" + "]" * 2000, encoding="utf-8")
    monkeypatch.setenv("DETECTOR_CALIBRATION_PATH", str(path))
    assert_defaults(resolve())


@pytest.mark.parametrize("change", [
    lambda p: p.pop("policy"),
    lambda p: p["policy"].update(confidence_level=float("nan")),
    lambda p: p["policy"].update(min_samples_per_class=True),
    lambda p: p["languages"]["en"].update(reasons=["unknown model training overlap"]),
    lambda p: p["languages"]["en"].update(training_overlap={"status": "unknown", "evidence": []}),
    lambda p: p["languages"]["en"].update(training_overlap={"status": "excluded", "evidence": []}),
    lambda p: p["languages"]["en"].pop("test_metrics"),
    lambda p: p["languages"]["en"]["counts"]["test"].update(human=29),
    lambda p: p["languages"]["en"]["counts"]["calibration"]["groups_by_label"].update(ai=29),
    lambda p: p["languages"]["en"]["test_metrics"]["human_high_false_flag"].update(of=39),
    lambda p: p["languages"]["en"]["test_metrics"]["ai_low_miss"].update(count=True),
    lambda p: p["languages"]["en"]["test_metrics"]["human_high_false_flag"].update(count=10, wilson_ci=[0.0, 0.0]),
    lambda p: p["languages"]["en"]["calibration_metrics"]["ai_low_miss"].update(count=10, wilson_ci=[0.0, 0.0]),
])
def test_unverified_counts_or_metrics_cannot_enable_validated_profile(tmp_path, monkeypatch, change):
    profile = valid_profile()
    change(profile)
    install_profile(tmp_path, monkeypatch, profile)
    result = resolve()
    assert_defaults(result)
    assert result["status"] == "unvalidated"


@pytest.mark.parametrize("count", [200, 2000])
def test_verified_profile_applies_at_document_length_bounds(tmp_path, monkeypatch, count):
    install_profile(tmp_path, monkeypatch)
    result = resolve(count=count)
    assert result["applied"] is True
    assert (result["low"], result["high"]) == (0.2, 0.6)


@pytest.mark.parametrize("count,scope", [(199, "document"), (2001, "document"), (500, "paragraph"), (500, "sentence")])
def test_out_of_range_or_non_document_scope_falls_back(tmp_path, monkeypatch, count, scope):
    install_profile(tmp_path, monkeypatch)
    assert_defaults(resolve(count=count, scope=scope))


def test_api_calibrates_document_but_not_paragraph_or_sentence(tmp_path, monkeypatch):
    from app.main import app, hub

    install_profile(tmp_path, monkeypatch)
    monkeypatch.setattr(hub, "phase", "ready")
    monkeypatch.setattr(hub, "loaded", {"zh": False, "en": True})
    monkeypatch.setattr(hub, "revisions", {"en": REVISION})
    monkeypatch.setattr(hub, "score", lambda text, lang: 0.65)
    monkeypatch.setattr(hub, "score_many", lambda texts, lang: [0.65 for _ in texts])
    block = "This synthetic paragraph has sufficient text to exercise the document verdict. " * 5
    text = block + "\n\n" + block
    with TestClient(app) as client:
        document = client.post("/api/detect", json={"lang": "en", "text": text}).json()
        section = client.post("/api/detect", json={"lang": "en", "text": text, "scope": "paragraph"}).json()
        sentences = client.post("/api/sentences", json={"lang": "en", "text": block}).json()
    assert document["score"] == section["score"] == 0.65
    assert document["verdict"] == "high"
    assert document["calibration"]["applied"] is True
    assert all(p["verdict"] == "uncertain" for p in document["paragraphs"])
    assert section["verdict"] == "uncertain"
    assert_defaults(section["calibration"])
    assert all(s["highlight"] == "mid" for s in sentences["sentences"])
