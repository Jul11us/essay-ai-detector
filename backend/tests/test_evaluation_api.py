import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app


def record(id="one", label="human", **updates):
    return {"id": id, "lang": "en", "label": label, "source": "Synthetic test fixture",
            "source_url": "https://example.com/fixture", "license": "fixture", "score": .2,
            "verdict": "low", "confidence": "medium", "model_id": "fixture-model",
            "model_revision": "sha256:" + "a" * 64, "char_count": 500, "word_count": 80, **updates}


def test_report_is_recomputed_and_private_fields_are_not_copied():
    data = [record(text="PRIVATE BODY", file="private/essay.txt", _path="C:/private/essay.txt"),
            record("two", "ai", score=.5, verdict="uncertain"), record("three", "mixed", score=.8, verdict="high")]
    response = TestClient(app).post("/api/evaluation/analyze", json={"records": data, "overall": {"accuracy": 1}})
    assert response.status_code == 200
    result = response.json()
    assert result["report"]["overall"]["n"] == 3
    assert result["report"]["overall"]["ai_uncertain"]["count"] == 1
    assert result["report"]["overall"]["ai_low_miss"]["count"] == 0
    assert result["calibration"] is None
    assert "PRIVATE BODY" not in response.text
    assert "private/essay.txt" not in response.text
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("patch", [{"score": 1.1}, {"score": True}, {"label": "unknown"}, {"source_url": "javascript:alert(1)"}, {"char_count": -1}])
def test_invalid_prediction_is_rejected(patch):
    response = TestClient(app).post("/api/evaluation/analyze", json={"records": [record(**patch)]})
    assert response.status_code == 400


def test_group_and_model_leakage_are_rejected():
    client = TestClient(app)
    for second in [record("one"), record("two", model_revision="other"),
                   record("two", split="test", group_id="group")]:
        first = record(split="calibration", group_id="group") if second.get("split") else record()
        assert client.post("/api/evaluation/analyze", json={"records": [first, second]}).status_code == 400


def test_manifest_accepts_canonical_relative_paths_and_rejects_cross_split_versions():
    client = TestClient(app)
    samples = [record(file="samples/one.txt", group_id="question", split="calibration"),
               record("two", "ai", file="samples/two.txt", group_id="question", split="calibration")]
    response = client.post("/api/evaluation/manifest", json={"samples": samples})
    assert response.status_code == 200
    assert "score" not in response.json()["samples"][0]
    for filename in ("C:/private/one.txt", "../one.txt", "one.exe"):
        bad = copy.deepcopy(samples)
        bad[0]["file"] = filename
        assert client.post("/api/evaluation/manifest", json={"samples": bad}).status_code == 400
    samples[1]["split"] = "test"
    assert client.post("/api/evaluation/manifest", json={"samples": samples}).status_code == 400


def test_incomplete_round_cannot_produce_a_validated_profile():
    rows = []
    for split in ("calibration", "test"):
        for index in range(30):
            for label, score, verdict in (("human", .1, "low"), ("ai", .9, "high")):
                rows.append(record(f"{split}-{index}-{label}", label, split=split, group_id=f"{split}-{index}",
                    score=score, verdict=verdict, input_sha256=f"{len(rows):064x}", api_pipeline="/api/detect",
                    training_overlap="excluded", training_overlap_evidence="Fixture provenance, not real performance"))
    client = TestClient(app)
    complete = client.post("/api/evaluation/analyze", json={"records": rows}).json()
    assert complete["calibration"]["languages"]["en"]["status"] == "validated"
    partial = client.post("/api/evaluation/analyze", json={"records": rows, "expected_sample_count": 121}).json()
    assert partial["report"]["evaluation_run"]["incomplete"] is True
    entry = partial["calibration"]["languages"]["en"]
    assert entry["status"] == "candidate"
    assert any("incomplete" in reason for reason in entry["reasons"])


def test_duplicate_content_cannot_inflate_calibration_groups():
    rows = [record("a", split="calibration", group_id="first", input_sha256="a" * 64),
            record("b", split="test", group_id="second", input_sha256="a" * 64)]
    assert TestClient(app).post("/api/evaluation/analyze", json={"records": rows}).status_code == 400
