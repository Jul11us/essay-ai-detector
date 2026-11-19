import copy
import json

import pytest

from accuracy_gate import compare, main, snapshot, table
from benchmark import summarize


def report():
    return {"records": [dict(id=f"{lang}-{domain}-{label}-{i}", lang=lang, label=label, domain=domain, source="HC3" if domain == "qa" else "C-ReD",
                             input_sha256=f"sha-{i}", dataset_revision="dataset-v1",
                             model_id=lang, model_revision="weights-v1", verdict="high" if label == "ai" else "low",
                             confidence="high")
                        for lang, domain in (("en", "qa"), ("zh", "qa"), ("zh", "composition"), ("zh", "paper"))
                        for label in ("human", "ai") for i in range(3)]}


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
    c = current["groups"]["en"]
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


@pytest.mark.parametrize("kind", ["empty", "duplicate", "missing_language", "missing_class", "bad_verdict", "no_hash"])
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


def test_generation_breakdowns_do_not_change_legacy_accuracy_snapshot():
    old = report()
    baseline = snapshot(old)
    rows = [{**r, "_sha256": r["input_sha256"],
             "generation_method": "paraphrase_back_translation_llm"} for r in old["records"]]
    new = summarize(rows, [{**r, "score": .9 if r["verdict"] == "high" else .1} for r in old["records"]])
    assert new["generation_families"]["paraphrase"]["n"] == len(old["records"])
    assert snapshot(new) == baseline
    assert compare(snapshot(new), baseline) == ([], [])


def test_chinese_group_misses_are_gated_independently():
    data = report()
    baseline = snapshot(data)
    for r in data["records"]:
        if r["domain"] == "composition" and r["label"] == "ai":
            r["verdict"] = "uncertain"
    failures, _ = compare(snapshot(data), baseline)
    assert failures == ["zh composition misses: 3 (baseline 0, tolerance +1)"]
    data["records"][6]["domain"] = "paper"
    with pytest.raises(ValueError, match="sample_fingerprint mismatch"):
        compare(snapshot(data), baseline)


def test_missing_group_and_old_schema_require_record():
    current = snapshot(report())
    for key, value in (("schema_version", 1), ("groups", {})):
        baseline = copy.deepcopy(current)
        baseline[key] = value
        with pytest.raises(ValueError, match="re-record"):
            compare(current, baseline)
    data = report()
    data["records"] = [r for r in data["records"] if r["domain"] != "paper"]
    with pytest.raises(ValueError, match="four evaluation groups"):
        snapshot(data)


def test_cli_multiple_reports_record_summary_and_fail(tmp_path, monkeypatch, capsys):
    records = report()["records"]
    paths = [tmp_path / "hc3.json", tmp_path / "cred.json"]
    paths[0].write_text(json.dumps({"records": records[:12]}))
    paths[1].write_text(json.dumps({"records": records[12:]}))
    baseline = tmp_path / "baseline.json"
    summary = tmp_path / "summary.md"
    argv = ["accuracy_gate.py", *map(str, paths), "--baseline", str(baseline)]
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setattr("sys.argv", [*argv, "--record"])
    main()
    assert json.loads(baseline.read_text())["schema_version"] == 2
    monkeypatch.setattr("sys.argv", argv)
    main()
    assert "PASS:" in capsys.readouterr().out
    assert "| zh paper |" in summary.read_text()
    for r in records[12:]:
        if r["label"] == "ai":
            r["verdict"] = "low"
    paths[1].write_text(json.dumps({"records": records[12:]}))
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 1
    assert "FAIL: zh composition misses: 3" in capsys.readouterr().out
