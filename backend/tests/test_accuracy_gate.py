import copy

import pytest

from accuracy_gate import compare, snapshot, table


def report():
    return {
        "records": [
            dict(
                id=f"{lang}-{label}-{i}",
                lang=lang,
                label=label,
                input_sha256=f"sha-{i}",
                dataset_revision="dataset-v1",
                model_id=lang,
                model_revision="weights-v1",
                verdict="high" if label == "ai" else "low",
                confidence="high",
            )
            for lang in ("en", "zh")
            for label in ("human", "ai")
            for i in range(3)
        ]
    }


def test_pass_tolerance_and_failure():
    original = report()
    baseline = snapshot(original)
    assert compare(baseline, baseline) == ([], [])
    original["records"][0]["verdict"] = "high"
    assert not compare(snapshot(original), baseline)[0]
    original["records"][1]["verdict"] = "high"
    assert "en false_flags: 2" in compare(snapshot(original), baseline)[0][0]


def test_uncertain_is_miss_and_abstain_is_separate():
    data = report()
    data["records"][3].update(verdict="uncertain", confidence="low")
    data["records"][4].update(verdict="low")
    current = snapshot(data)
    c = current["languages"]["en"]
    assert (c["misses"], c["ai_uncertain"], c["abstain"]) == (2, 1, 1)
    assert "| en | 6 (3/3) | 0 | 2 | 0/1 | 1 |" in table(current)
    assert compare(snapshot(report()), current)[1]


@pytest.mark.parametrize("key", ["input_sha256", "dataset_revision", "model_revision", "id"])
def test_identity_change_requires_record(key):
    data = report()
    baseline = snapshot(data)
    data["records"][0][key] += "changed"
    with pytest.raises(ValueError, match="Mixed model|re-record"):
        compare(snapshot(data), baseline)


@pytest.mark.parametrize(
    "kind", ["empty", "duplicate", "missing_language", "missing_class", "bad_verdict", "no_hash"]
)
def test_invalid_report(kind):
    data = report()
    if kind == "empty":
        data["records"] = []
    elif kind == "duplicate":
        data["records"].append(copy.deepcopy(data["records"][0]))
    elif kind == "missing_language":
        data["records"] = data["records"][:6]
    elif kind == "missing_class":
        data["records"] = [r for r in data["records"] if r["label"] == "ai"]
    elif kind == "bad_verdict":
        data["records"][0]["verdict"] = "invalid"
    else:
        del data["records"][0]["input_sha256"]
    with pytest.raises(ValueError):
        snapshot(data)


def test_order_independent_and_counts_only():
    data = report()
    baseline = snapshot(data)
    data["records"].reverse()
    assert snapshot(data) == baseline
    assert "records" not in baseline
