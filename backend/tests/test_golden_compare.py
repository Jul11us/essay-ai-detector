"""compare() 的单元测试。

这项检查的价值全在「它真的会红」，所以漂移检测逻辑本身必须有测试，
而且这些测试不需要模型。
"""

from golden import GOLDEN_TOLERANCE, compare


def test_identical_snapshots_have_no_diffs():
    snapshot = {"a": {"score": 0.007, "verdict": "low", "paras": [0.167, 0.0]}}
    assert compare(snapshot, snapshot) == []


def test_drift_inside_tolerance_is_ignored():
    baseline = {"zh": {"ai_style": 0.9993664622306824}}
    current = {"zh": {"ai_style": 0.9993664622306824 + GOLDEN_TOLERANCE / 2}}
    assert compare(baseline, current) == []


def test_real_drift_is_caught_with_the_path_and_the_delta():
    baseline = {"en_essay": {"score": 0.007}}
    current = {"en_essay": {"score": 0.0076}}
    diffs = compare(baseline, current)
    assert len(diffs) == 1
    assert "en_essay.score" in diffs[0]
    assert "0.007" in diffs[0]


def test_a_drift_at_the_display_resolution_is_caught():
    """0.1% 就是前端显示的一位小数，只差这一档也必须红。"""
    diffs = compare({"score": 0.007}, {"score": 0.008})
    assert diffs and "score" in diffs[0]


def test_changed_paragraph_count_is_caught():
    """分段逻辑一变（比如最小段长改了），长度对不上要明确报出来。"""
    baseline = {"en_essay": {"paragraph_scores": [0.167, 0.0, 0.0]}}
    current = {"en_essay": {"paragraph_scores": [0.167, 0.0]}}
    diffs = compare(baseline, current)
    assert len(diffs) == 1
    assert "长度 3 -> 2" in diffs[0]


def test_missing_and_extra_keys_are_caught():
    diffs = compare({"a": 1, "b": 2}, {"a": 1, "c": 3})
    assert any("b: 基线里有，实际缺失" in d for d in diffs)
    assert any("c: 实际多出来的字段" in d for d in diffs)


def test_a_number_replaced_by_a_string_is_caught():
    diffs = compare({"score": 0.007}, {"score": "0.007"})
    assert diffs and "基线是数字" in diffs[0]


def test_booleans_are_compared_as_values_not_numbers():
    """True 不能被当成 1 而通过容差比较。"""
    diffs = compare({"mixed_variance": False}, {"mixed_variance": True})
    assert diffs and "mixed_variance" in diffs[0]
    assert compare({"mixed_variance": False}, {"mixed_variance": False}) == []


def test_verdict_change_is_caught():
    diffs = compare(
        {"en_essay": {"verdict": "low"}}, {"en_essay": {"verdict": "uncertain"}}
    )
    assert diffs and "verdict" in diffs[0]
