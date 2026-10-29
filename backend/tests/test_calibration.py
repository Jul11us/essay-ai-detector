import copy
import hashlib

import pytest

from app.calibration_fit import (
    build_profile,
    document_verdict,
    fit_thresholds,
    validate_split_groups,
    wilson_interval,
)


def records(n=30, lang="en"):
    result = []
    for split in ("calibration", "test"):
        for i in range(n):
            for label, score in (("human", 0.1), ("ai", 0.9)):
                id = f"{lang}-{split}-{i}-{label}"
                result.append(
                    {
                        "id": id,
                        "lang": lang,
                        "label": label,
                        "split": split,
                        "group_id": f"{lang}-{split}-{i}",
                        "score": score,
                        "confidence": "high",
                        "char_count": 2000,
                        "word_count": 400,
                        "model_id": f"model-{lang}",
                        "model_revision": "revision-1",
                        "source": "public controlled test",
                        "source_url": "https://example.org/public-dataset",
                        "license": "CC-BY-SA-4.0",
                        "writer_group": "known-source",
                        "api_pipeline": "/api/detect",
                        "input_sha256": hashlib.sha256(id.encode()).hexdigest(),
                        "training_overlap": "excluded",
                        "training_overlap_evidence": "Synthetic unit-test score fixtures; no real model or source text used.",
                    }
                )
    return result


def test_wilson_boundaries_and_zero_denominator():
    assert wilson_interval(0, 0) is None
    low, high = wilson_interval(0, 30)
    assert low == 0 or low == pytest.approx(0, abs=1e-16)
    assert high == pytest.approx(0.1135133931739688)
    low, high = wilson_interval(30, 30)
    assert low == pytest.approx(0.8864866068260312) and high == pytest.approx(1)
    assert wilson_interval(5, 10)[0] < 0.5 < wilson_interval(5, 10)[1]


@pytest.mark.parametrize(
    "count,denominator,level",
    [
        (True, 1, 0.95),
        (1, False, 0.95),
        (2, 1, 0.95),
        (-1, 1, 0.95),
        (1, 1, float("nan")),
        (1, 1, 1),
        (1, 1, True),
    ],
)
def test_invalid_wilson_inputs(count, denominator, level):
    with pytest.raises(ValueError):
        wilson_interval(count, denominator, level)


def test_validated_profile_binds_model_and_independent_sources():
    profile = build_profile(records())
    lang = profile["languages"]["en"]
    assert profile["schema_version"] == 1 and profile["evaluation_unit"] == "document"
    assert profile["score_semantics"] == "raw_model_score_not_authorship_probability"
    assert len(profile["dataset_fingerprint"]) == 64
    assert lang["status"] == "validated" and lang["reasons"] == []
    assert lang["model_id"] == "model-en" and lang["model_revision"] == "revision-1"
    assert lang["counts"]["test"]["groups"] == 30
    assert lang["test_metrics"]["uncertain"]["count"] == 0
    assert lang["test_metrics"]["human_high_false_flag"]["wilson_ci"][1] < 0.2
    assert lang["applicability"]["char_count"] == {"min": 2000, "max": 2000}
    assert lang["training_overlap"]["status"] == "excluded"
    assert lang["training_overlap"]["evidence"] == [
        "Synthetic unit-test score fixtures; no real model or source text used."
    ]
    assert "zh" not in profile["languages"]


def test_test_scores_never_fit_thresholds_and_can_reject_candidate():
    original = records()
    baseline = build_profile(original)["languages"]["en"]
    altered = copy.deepcopy(original)
    for r in altered:
        if r["split"] == "test":
            r["score"] = 0.9999 if r["label"] == "human" else 0.0001
    changed = build_profile(altered)["languages"]["en"]
    assert (changed["low"], changed["high"]) == (baseline["low"], baseline["high"])
    assert changed["status"] == "candidate"
    assert changed["test_metrics"]["human_high_false_flag"]["rate"] == 1
    assert (
        "independent test Wilson upper bounds do not meet error constraints" in changed["reasons"]
    )
    with pytest.raises(ValueError, match="only calibration"):
        fit_thresholds(original)


def test_group_leakage_including_mixed_is_rejected():
    data = records()
    data[-1]["group_id"] = data[0]["group_id"]
    with pytest.raises(ValueError, match="Group leakage"):
        build_profile(data)
    data[-1]["label"] = "mixed"
    with pytest.raises(ValueError, match="Group leakage"):
        build_profile(data)


def test_identical_content_under_new_id_cannot_hide_leakage():
    data = records()
    data[-1]["input_sha256"] = data[0]["input_sha256"]
    with pytest.raises(ValueError, match="Duplicate input"):
        build_profile(data)


@pytest.mark.parametrize("score", [True, False, float("nan"), float("inf"), -0.1, 1.1, "0.5"])
def test_invalid_calibration_scores(score):
    data = records()
    data[0]["score"] = score
    with pytest.raises(ValueError, match="finite numbers"):
        build_profile(data)
    with pytest.raises(ValueError, match="finite numbers"):
        fit_thresholds([data[0]])


def test_duplicate_ids_invalid_language_and_model_mix():
    for key, value, error in (
        ("id", "en-calibration-0-human", "unique"),
        ("lang", "fr", "language"),
        ("model_id", "other-model", "mixed models"),
        ("model_revision", "other-revision", "mixed models"),
    ):
        data = records()
        data[-1][key] = value
        with pytest.raises(ValueError, match=error):
            build_profile(data)


def test_language_thresholds_are_separate():
    both = records(lang="en") + records(lang="zh")
    profile = build_profile(both)
    assert set(profile["languages"]) == {"en", "zh"}
    assert profile["languages"]["en"]["model_id"] != profile["languages"]["zh"]["model_id"]


def test_missing_classes_small_sample_and_missing_metadata_cannot_validate():
    humans_only = [r for r in records() if r["label"] == "human"]
    assert build_profile(humans_only)["languages"]["en"]["status"] == "unvalidated"
    small = build_profile(records(25))["languages"]["en"]
    assert small["status"] == "candidate" and any(
        "fewer than 30" in reason for reason in small["reasons"]
    )
    for key, replacement in (
        ("model_revision", "unknown"),
        ("confidence", "unknown"),
        ("char_count", None),
        ("api_pipeline", "unspecified"),
        ("source_url", None),
        ("input_sha256", None),
    ):
        data = records()
        for r in data:
            r[key] = replacement
        assert build_profile(data)["languages"]["en"]["status"] == "candidate"


def test_repeated_versions_cannot_supply_independent_sample_floor():
    data = records()
    for r in data:
        r["group_id"] = r["split"] + "-only-one-original"
    assert build_profile(data)["languages"]["en"]["status"] == "candidate"


def test_training_overlap_must_be_excluded_with_evidence():
    data = records()
    data[0]["training_overlap"] = "unknown"
    lang = build_profile(data)["languages"]["en"]
    assert lang["status"] == "candidate"
    assert "model training overlap has not been excluded with evidence" in lang["reasons"]
    assert lang["training_overlap"]["status"] == "unknown"
    data[0]["training_overlap"] = "excluded"
    data[0]["training_overlap_evidence"] = ""
    assert build_profile(data)["languages"]["en"]["status"] == "candidate"
    data[0]["training_overlap"] = "possible"
    assert build_profile(data)["languages"]["en"]["training_overlap"]["status"] == "possible"


def test_no_feasible_thresholds_are_unvalidated():
    data = records()
    for r in data:
        r["score"] = 1 if r["label"] == "human" else 0
    lang = build_profile(data)["languages"]["en"]
    assert lang["status"] == "unvalidated" and lang["low"] is None and lang["high"] is None


def test_mixed_is_separate_and_never_changes_grid_or_binary_metrics():
    data = records()
    baseline = build_profile(data)["languages"]["en"]
    for split in ("calibration", "test"):
        data.append(
            {
                **data[0],
                "id": f"mixed-{split}",
                "label": "mixed",
                "score": 0.54321,
                "split": split,
                "group_id": f"mixed-{split}",
                "input_sha256": f"hash-mixed-{split}",
                "char_count": 10000,
                "writer_group": "constructed_mixed",
            }
        )
    changed = build_profile(data)["languages"]["en"]
    assert (changed["low"], changed["high"]) == (baseline["low"], baseline["high"])
    assert changed["test_metrics"]["n_binary"] == 60
    assert changed["test_metrics"]["mixed_n"] == 1
    assert sum(changed["test_metrics"]["mixed_verdicts"].values()) == 1
    assert "accuracy" not in changed["test_metrics"]
    assert changed["applicability"]["char_count"]["max"] == 2000
    assert "constructed_mixed" not in changed["applicability"]["writer_groups"]


def test_exact_boundary_semantics_and_low_confidence_guard():
    assert document_verdict(0.39, "low", 0.4, 0.75) == "low"
    assert document_verdict(0.4, "high", 0.4, 0.75) == "uncertain"
    assert document_verdict(0.75, "high", 0.4, 0.75) == "high"
    assert document_verdict(0.99, "low", 0.4, 0.75) == "uncertain"
    data = records()
    for r in data:
        if r["label"] == "ai":
            r["confidence"] = "low"
    lang = build_profile(data)["languages"]["en"]
    assert lang["status"] == "validated"
    assert lang["test_metrics"]["ai_uncertain"]["rate"] == 1


def test_descriptive_manifest_still_supported_but_cannot_fit_without_splits():
    validate_split_groups([{"id": "old"}])
    with pytest.raises(ValueError, match="split=calibration/test"):
        build_profile([{"id": "old"}])


@pytest.mark.parametrize(
    "options",
    [
        {"max_false_positive_rate": True},
        {"max_false_negative_rate": float("nan")},
        {"confidence_level": 1},
        {"min_samples_per_class": True},
        {"min_samples_per_class": 0},
    ],
)
def test_invalid_fit_policy_rejected(options):
    with pytest.raises(ValueError):
        build_profile(records(), **options)
