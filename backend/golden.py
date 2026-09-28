"""黄金分数基线：把「这次改动有没有动分数」变成能自动检查的事。

现有 84 个单元测试全部用 mock 模型（规格 §10 就是这么要求的），所以靠升级依赖
（requirements.txt 里 torch / transformers 都没固定版本）或改动分段、加权、档位
逻辑导致的分数漂移，它们一个都不会红。这里用真实模型跑固定样本、记下分数，之后比对。

容差依据（同机实测，非猜测）：线程数 1→32 时，未取整概率的最大漂移约 5e-7，
取整到四位小数的分数完全一致。1e-4 留了约 200 倍余量，又远小于一次显示跳动
（0.1% = 1e-3）。跨机器 / BLAS 的差异没有实测过，可能更大；如果换机器后满屏都是
极小的 delta，那就是该放宽这个数的信号——失败信息里会带上实际差值，便于判断。

重新录制基线：在 backend 目录下跑 `python golden.py`（会覆盖）。
跑这项检查：`pytest -m golden`
"""

from __future__ import annotations

import json
from pathlib import Path

# 允许的最大漂移。见模块文档里的实测依据。
GOLDEN_TOLERANCE = 1e-4

BACKEND_DIR = Path(__file__).resolve().parent
BASELINE_PATH = BACKEND_DIR / "tests" / "golden_baseline.json"
ESSAY_PATH = BACKEND_DIR.parent / "experiments" / "essay.txt"


def zh_document() -> str:
    """中文固定样本：两段，且都长到足以触发 zhv3 的 512/256 滑窗。"""
    from app.sanity import AI_STYLE_ZH, HUMAN_STYLE_ZH

    return "\n\n".join([AI_STYLE_ZH * 3, HUMAN_STYLE_ZH * 2])


def _summary(result: dict) -> dict:
    return {
        "score": result["score"],
        "verdict": result["verdict"],
        "confidence": result["confidence"],
        "mixed_variance": result["mixed_variance"],
        "char_count": result["char_count"],
        # 段落数、档位和每段字符数一起记：分段逻辑或档位阈值一变，这里就会红，
        # 而不只是「总分碰巧没变」。
        "paragraph_scores": [p["score"] for p in result["paragraphs"]],
        "paragraph_verdicts": [p["verdict"] for p in result["paragraphs"]],
        "paragraph_char_counts": [p["char_count"] for p in result["paragraphs"]],
        "review_risk": result["review_risk"],
    }


def collect(hub) -> dict:
    """跑一遍固定样本，返回可 JSON 序列化的分数快照。"""
    from app.pipeline import run_detect
    from app.sanity import AI_STYLE_ZH, HUMAN_STYLE_ZH

    essay = ESSAY_PATH.read_text(encoding="utf-8")
    return {
        "en_essay": _summary(run_detect("en", essay, None, None, hub.score)),
        "zh_doc": _summary(run_detect("zh", zh_document(), None, None, hub.score)),
        # 分类头方向自检的两个样本，用公开的 score() 拿到未取整的值
        "zh_label_probe": {
            "ai_style": hub.score(AI_STYLE_ZH, "zh"),
            "human_style": hub.score(HUMAN_STYLE_ZH, "zh"),
        },
    }


def load_baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def compare(baseline: dict, current: dict, tolerance: float = GOLDEN_TOLERANCE) -> list[str]:
    """返回所有超出容差的差异；空列表代表与基线一致。"""
    diffs: list[str] = []
    _walk("", baseline, current, tolerance, diffs)
    return diffs


def _walk(path: str, expected: object, actual: object, tolerance: float, diffs: list[str]) -> None:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            diffs.append(f"{path}: 基线是对象，实际是 {type(actual).__name__}")
            return
        for key, value in expected.items():
            child = f"{path}.{key}" if path else key
            if key not in actual:
                diffs.append(f"{child}: 基线里有，实际缺失")
            else:
                _walk(child, value, actual[key], tolerance, diffs)
        for key in actual:
            if key not in expected:
                child = f"{path}.{key}" if path else key
                diffs.append(f"{child}: 实际多出来的字段")
        return

    if isinstance(expected, list):
        if not isinstance(actual, list):
            diffs.append(f"{path}: 基线是数组，实际是 {type(actual).__name__}")
            return
        if len(expected) != len(actual):
            diffs.append(f"{path}: 长度 {len(expected)} -> {len(actual)}（分段变了？）")
            return
        for index, (e, a) in enumerate(zip(expected, actual)):
            _walk(f"{path}[{index}]", e, a, tolerance, diffs)
        return

    if _is_number(expected):
        if not _is_number(actual):
            diffs.append(f"{path}: 基线是数字 {expected!r}，实际是 {actual!r}")
            return
        delta = abs(float(actual) - float(expected))  # type: ignore[arg-type]
        if delta > tolerance:
            diffs.append(f"{path}: {expected!r} -> {actual!r}（差 {delta:.2e}）")
        return

    if expected != actual:
        diffs.append(f"{path}: {expected!r} -> {actual!r}")


def _main() -> None:
    from app.loader import ModelHub

    hub = ModelHub()
    hub._load_all()
    if not all(hub.loaded.values()):
        raise SystemExit(f"模型没全部就绪，无法录制基线：{hub.detail}")

    snapshot = collect(hub)
    BASELINE_PATH.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"已写入 {BASELINE_PATH}")
    print(json.dumps(snapshot, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _main()
