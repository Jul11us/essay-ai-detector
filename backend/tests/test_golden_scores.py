"""真实模型下的黄金分数检查。

默认不跑：它要加载 1.5 GB 权重，而单元测试按规格 §10 保持 model-free。
跑法：`pytest -m golden`

红了怎么办：
- 如果是**有意的**改动（比如决定调整分段上限或档位），全新录制基线：
  在 backend 目录下 `python golden.py`，然后把这个 JSON 的 diff 一起提交，
  让「分数变了多少」变成一次可见的评审，而不是悄悄发生的副作用。
- 如果是**无意的**，那就是这次改动动了分数，去查上面的 path（会指到具体字段）。
"""

import pytest

from golden import BASELINE_PATH, collect, compare, load_baseline

from app.loader import ModelHub, default_vanguard_path

pytestmark = pytest.mark.golden


@pytest.fixture(scope="module")
def hub():
    if not (default_vanguard_path() / "config.json").exists():
        pytest.skip(f"没有本地 Vanguard 权重：{default_vanguard_path()}")
    if not BASELINE_PATH.exists():
        pytest.skip(f"没有基线文件，先在 backend 下跑 python golden.py：{BASELINE_PATH}")

    instance = ModelHub()
    instance._load_all()
    if not all(instance.loaded.values()):
        # 中英文都要，否则缺的那半边只能报「字段缺失」，看不出真正的原因
        pytest.skip(f"模型没全部就绪，跳过黄金检查：{instance.detail}")
    return instance


def test_scores_match_baseline(hub):
    diffs = compare(load_baseline(), collect(hub))
    assert not diffs, "分数相比基线有漂移：\n" + "\n".join(diffs)


def test_baseline_covers_both_languages():
    """基线本身要覆盖中英文，否则「没漂移」可能只是没测到。"""
    baseline = load_baseline()
    assert set(baseline) == {"en_essay", "zh_doc", "zh_label_probe"}
    assert baseline["zh_label_probe"]["ai_style"] > baseline["zh_label_probe"]["human_style"]
