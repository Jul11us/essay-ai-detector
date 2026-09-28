"""加载阶段的权重完整性校验。

原来只有 Vanguard 那条路径核对 missing/unexpected keys，中文路径没有：
换个标签数不同的模型时 `from_pretrained` 会静默随机初始化分类头，
输出全是噪声却不报错。现在两条路径共用同一个校验。
"""

import threading

import pytest

from app.loader import ModelHub, assert_clean_loading


def test_clean_loading_passes():
    assert_clean_loading(
        {"missing_keys": [], "unexpected_keys": [], "mismatched_keys": []}
    )


def test_missing_keys_are_fatal():
    with pytest.raises(RuntimeError) as ei:
        assert_clean_loading({"missing_keys": ["classifier.weight"], "unexpected_keys": []})
    assert "missing=1" in str(ei.value)


def test_unexpected_keys_are_fatal():
    with pytest.raises(RuntimeError) as ei:
        assert_clean_loading({"missing_keys": [], "unexpected_keys": ["classifier.bias"]})
    assert "unexpected=1" in str(ei.value)


def test_mismatched_keys_are_fatal():
    with pytest.raises(RuntimeError) as ei:
        assert_clean_loading(
            {"missing_keys": [], "unexpected_keys": [], "mismatched_keys": [("a", (1,), (2,))]}
        )
    assert "mismatched=1" in str(ei.value)


def test_absent_keys_are_treated_as_clean():
    assert_clean_loading({})


def test_phase_is_downloading_before_anything_is_tried():
    hub = ModelHub()
    hub._sync_phase()
    assert hub.phase == "downloading"


def test_english_ready_while_chinese_still_loads_is_not_reported_as_failure():
    """英文就绪、中文还在下载时，detail 不能说「未加载」。"""
    hub = ModelHub()
    hub.loaded = {"zh": False, "en": True}
    hub._sync_phase()
    assert hub.phase == "ready"
    assert "正在准备中文模型" in hub.detail
    assert "未加载" not in hub.detail


def test_chinese_failure_keeps_its_reason():
    hub = ModelHub()
    hub.loaded = {"zh": False, "en": True}
    hub._errors["zh"] = "当前环境没装 modelscope"
    hub._sync_phase()
    assert hub.phase == "ready"
    assert hub.detail == "英文已就绪；中文未加载：当前环境没装 modelscope"


def test_error_phase_only_when_nothing_is_usable():
    hub = ModelHub()
    hub.loaded = {"zh": False, "en": False}
    hub._errors["en"] = "找不到 Vanguard 权重"
    hub._sync_phase()
    assert hub.phase == "error"
    assert "找不到 Vanguard 权重" in hub.detail


def test_both_loaded_ignores_stale_errors():
    hub = ModelHub()
    hub.loaded = {"zh": True, "en": True}
    hub._errors["zh"] = "上一轮失败"
    hub._sync_phase()
    assert hub.phase == "ready"
    assert hub.detail == "中英文模型均已就绪"


def test_status_reports_loading_only_while_the_loader_thread_runs():
    """前端靠这个字段决定什么时候停止轮询 /api/status。"""
    hub = ModelHub()
    assert hub.status()["loading"] is False  # 还没启动加载

    blocker = threading.Event()
    hub._thread = threading.Thread(target=blocker.wait, daemon=True)
    hub._thread.start()
    try:
        assert hub.status()["loading"] is True
    finally:
        blocker.set()
        hub._thread.join()

    assert hub.status()["loading"] is False
