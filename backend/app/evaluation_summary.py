"""把评测报告（和可选的校准配置）写成一页人能读的 Markdown。

只读汇总后的计数、区间和元数据；报告里的 records 本来就不含作文正文，这里也不输出样本 ID，
所以 summary.md 可以放心转给别人看。固定的局限说明总是写在最前面，不会因为数字好看就省掉。
"""

from __future__ import annotations

from collections import Counter

LANG_NAMES = {"en": "英文", "zh": "中文"}
LENGTH_NAMES = {
    "under_400_chars": "< 400 字符",
    "400_to_1499_chars": "400–1499 字符",
    "1500_plus_chars": "≥ 1500 字符",
    "unknown": "长度未知",
}
VERDICT_NAMES = {"low": "较低", "uncertain": "不确定", "high": "较高"}
STATUS_NAMES = {
    "validated": "validated（满足本次策略，可显式启用）",
    "candidate": "candidate（只是候选，不可启用）",
    "unvalidated": "unvalidated（找不到满足约束的阈值）",
}

CAVEATS = (
    "分数是模型原始分数，不是 AI 所写文字的占比，也不是作者为 AI 的概率。",
    "区间是这些样本上比例的 Wilson 区间，不保证真实人群上的表现；同一原稿的多个版本彼此相关。",
    "结果只适用于清单里的来源、语言、长度和作者组别；不能推到学生作文、非母语作者、"
    "其他体裁或更新的生成模型，除非样本里确实包含它们。",
    "“不确定”不算检测成功；误报、漏报要和不确定比例一起看。",
)


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def fmt_rate(rate: dict | None) -> str:
    """`3/30 = 10.0%（2.1%–26.5%）`；分母为 0 时写“无样本”，不写 0%。"""
    if not rate or not rate.get("of"):
        return "无样本"
    ci = rate.get("wilson_ci")
    interval = f"（{_pct(ci[0])}–{_pct(ci[1])}）" if ci else ""
    return f"{rate['count']}/{rate['of']} = {_pct(rate['rate'])}{interval}"


def _models(records: list[dict]) -> dict[str, set[tuple[str, str]]]:
    seen: dict[str, set[tuple[str, str]]] = {}
    for r in records:
        seen.setdefault(r["lang"], set()).add(
            (str(r.get("model_id", "unknown")), str(r.get("model_revision", "unknown")))
        )
    return seen


def _rate_row(label: str, c: dict) -> str:
    return (
        f"| {label} | {c['labels'].get('human', 0)} | {fmt_rate(c['human_high_false_flag'])} | "
        f"{c['labels'].get('ai', 0)} | {fmt_rate(c['ai_low_miss'])} | "
        f"{fmt_rate(c['human_uncertain'])} | {fmt_rate(c['ai_uncertain'])} | "
        f"{fmt_rate(c['confidence_insufficient'])} |"
    )


RATE_HEADER = (
    "| 分组 | 人写样本 | 误报（人写判较高） | AI 样本 | 漏报（AI 判较低） | 人写判不确定 | "
    "AI 判不确定 | 充分度不足 |\n| --- | ---: | --- | ---: | --- | --- | --- | --- |"
)


def _calibration_section(profile: dict) -> list[str]:
    policy = profile["policy"]
    out = [
        "## 阈值校准",
        "",
        f"策略：误报和漏报的 {policy['confidence_level'] * 100:.0f}% Wilson 区间上界都不超过 "
        f"{_pct(policy['max_false_positive_rate'])} / {_pct(policy['max_false_negative_rate'])}；"
        f"每个 split 每类至少 {policy['min_samples_per_class']} 个独立组。"
        "阈值只在校准集上拟合，测试集只用来事后核对。",
        "",
    ]
    for lang, item in sorted(profile["languages"].items()):
        name = LANG_NAMES.get(lang, lang)
        out += [
            f"### {name}",
            "",
            f"- 状态：**{STATUS_NAMES.get(item['status'], item['status'])}**",
        ]
        if item.get("low") is not None:
            out.append(f"- 拟合出的门槛：较低 < {item['low']:.2f}，较高 ≥ {item['high']:.2f}")
        for title, key in (("校准集", "calibration_metrics"), ("独立测试集", "test_metrics")):
            m = item.get(key)
            if m:
                out.append(
                    f"- {title}：误报 {fmt_rate(m['human_high_false_flag'])}；"
                    f"漏报 {fmt_rate(m['ai_low_miss'])}；不确定 {fmt_rate(m['uncertain'])}"
                )
        overlap = item.get("training_overlap", {})
        out.append(f"- 与检测模型训练数据的重叠：{overlap.get('status', 'unknown')}")
        chars = item.get("applicability", {}).get("char_count", {})
        if chars.get("min") is not None:
            out.append(f"- 适用长度（人写/AI 样本实际范围）：{chars['min']}–{chars['max']} 字符")
        if item.get("reasons"):
            out.append("- 不能启用的原因：")
            out += [f"  - `{reason}`" for reason in item["reasons"]]
        out.append("")
    return out


def render_summary(report: dict, profile: dict | None = None) -> str:
    records = report.get("records", [])
    overall = report["overall"]
    groups = report.get("groups", {})
    langs = sorted({r["lang"] for r in records})
    out = [
        "# 评测摘要",
        "",
        f"生成时间：{report.get('generated_at', '未知')} · 样本 {overall['n']} 份，"
        f"独立组 {overall['groups']} 个 · 语言："
        + ("、".join(LANG_NAMES.get(lang, lang) for lang in langs) or "无"),
        "",
        "## 先读这几条",
        "",
        *[f"- {line}" for line in CAVEATS],
    ]
    if profile is None or all(
        item.get("training_overlap", {}).get("status") != "excluded"
        for item in profile.get("languages", {}).values()
    ):
        out.append(
            "- 没有证据排除这些样本进入过检测模型的训练数据，结果可能偏乐观，不能当作独立验证。"
        )
    out += ["", "## 默认展示门槛下的结果", "", RATE_HEADER, _rate_row("全部", overall)]
    for lang in langs:
        key = f"lang:{lang}"
        if key in groups:
            out.append(_rate_row(LANG_NAMES.get(lang, lang), groups[key]))
    out += ["", "## 按长度", "", RATE_HEADER]
    for lang in langs:
        for bucket, name in LENGTH_NAMES.items():
            key = f"lang:{lang}|length:{bucket}"
            if key in groups:
                out.append(_rate_row(f"{LANG_NAMES.get(lang, lang)} · {name}", groups[key]))
    out.append("")
    if overall.get("mixed_n"):
        dist = Counter(overall.get("mixed", {}))
        parts = "、".join(
            f"{VERDICT_NAMES[v]} {dist.get(v, 0)}" for v in ("low", "uncertain", "high")
        )
        out += [
            "## 混合稿（只看分布，没有对错）",
            "",
            f"{overall['mixed_n']} 份：{parts}。混合稿没有二元真值，不参与误报、漏报和阈值拟合。",
            "",
        ]
    if profile is not None:
        out += _calibration_section(profile)
    out += ["## 模型与数据", ""]
    for lang, models in sorted(_models(records).items()):
        listed = "；".join(f"`{m}` @ `{rev}`" for m, rev in sorted(models))
        out.append(f"- {LANG_NAMES.get(lang, lang)}模型：{listed}")
    if profile is not None:
        out.append(f"- 样本集指纹：`{profile['dataset_fingerprint']}`")
    latency = report.get("latency", {})
    if latency.get("n"):
        out.append(
            f"- 单次请求耗时（含上传、提取和推理）：均值 {latency['mean_ms'] / 1000:.1f} 秒，"
            f"中位数 {latency['median_ms'] / 1000:.1f} 秒，P95 {latency['p95_ms'] / 1000:.1f} 秒"
        )
    out.append("")
    return "\n".join(out)
