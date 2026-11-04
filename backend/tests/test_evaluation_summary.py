from app.calibration_fit import build_profile
from app.evaluation_stats import summarize
from app.evaluation_summary import fmt_rate, render_summary


def _dataset(n_per_class=4):
    rows, predictions = [], []
    for split in ("calibration", "test"):
        for i in range(n_per_class):
            for label, score in (("human", 0.1 + i * 0.01), ("ai", 0.9 - i * 0.01)):
                sid = f"en-{split}-{i}-{label}"
                rows.append(
                    {
                        "id": sid,
                        "lang": "en",
                        "label": label,
                        "source": "fixture",
                        "split": split,
                        "group_id": f"{split}-{i}",
                    }
                )
                predictions.append(
                    {
                        "id": sid,
                        "score": score,
                        "verdict": "low" if score < 0.4 else "high",
                        "model_id": "fixture-model",
                        "model_revision": "rev-1",
                        "confidence": "medium",
                        "char_count": 900,
                        "word_count": 150,
                        "latency_ms": 2000,
                        "api_pipeline": "/api/detect",
                    }
                )
    rows.append(
        {
            "id": "mixed-1",
            "lang": "en",
            "label": "mixed",
            "source": "fixture",
            "split": "test",
            "group_id": "test-0",
        }
    )
    predictions.append(
        {
            "id": "mixed-1",
            "score": 0.5,
            "verdict": "uncertain",
            "model_id": "fixture-model",
            "model_revision": "rev-1",
            "confidence": "medium",
            "char_count": 1600,
            "word_count": 300,
            "latency_ms": 3000,
            "api_pipeline": "/api/detect",
        }
    )
    return rows, predictions


def test_rates_show_counts_interval_and_no_zero_for_missing_samples():
    assert fmt_rate({"count": 0, "of": 0, "rate": None, "wilson_ci": None}) == "无样本"
    text = fmt_rate({"count": 3, "of": 30, "rate": 0.1, "wilson_ci": [0.0346, 0.2565]})
    assert text == "3/30 = 10.0%（3.5%–25.7%）"


def test_summary_reports_rates_calibration_and_caveats_without_ids_or_text():
    rows, predictions = _dataset()
    report = summarize(rows, predictions)
    profile = build_profile(report["records"])
    text = render_summary(report, profile)

    assert "## 先读这几条" in text and "不是作者为 AI 的概率" in text
    # 训练重叠未排除时必须明说
    assert "没有证据排除这些样本进入过检测模型的训练数据" in text
    assert "| 英文 | 8 | 0/8 = 0.0%" in text
    assert "英文 · 400–1499 字符" in text
    assert "混合稿" in text and "不确定 1" in text
    # 样本太少：只能是候选，原因要列出来
    assert "candidate（只是候选，不可启用）" in text or "unvalidated" in text
    assert (
        "校准集的人写独立样本/组少于 30 个（`calibration: fewer than 30 independent human "
        "samples/groups`）" in text
    )
    assert "`fixture-model` @ `rev-1`" in text and profile["dataset_fingerprint"] in text
    assert "均值 2.1 秒" in text
    for row in rows:
        assert row["id"] not in text


def test_summary_without_calibration_still_warns_about_training_overlap():
    rows, predictions = _dataset(2)
    text = render_summary(summarize(rows, predictions))
    assert "## 阈值校准" not in text
    assert "没有证据排除这些样本进入过检测模型的训练数据" in text


def test_every_reason_the_calibration_can_give_is_explained_in_chinese():
    from app.evaluation_summary import explain_reason

    reasons = [
        "calibration: missing human class",
        "test: fewer than 30 independent ai samples/groups",
        "test: repeated human versions are statistically correlated",
        "model id/revision is unknown",
        "missing exact API confidence/length metadata",
        "exact /api/detect pipeline provenance is unverified",
        "missing source URL/license provenance",
        "missing input fingerprints for duplicate/leakage checks",
        "model training overlap has not been excluded with evidence",
        "no calibration threshold pair meets Wilson error constraints",
        "independent test Wilson upper bounds do not meet error constraints",
    ]
    for reason in reasons:
        text = explain_reason(reason)
        assert not text.startswith("`"), reason  # 有中文说明
        assert f"（`{reason}`）" in text  # 原文保留
    assert explain_reason("something new") == "`something new`"


def test_ai_class_name_is_spaced_like_the_rest_of_the_site():
    from app.evaluation_summary import explain_reason

    assert explain_reason("test: missing ai class").startswith("测试集缺少 AI 样本")
    assert explain_reason("calibration: fewer than 30 independent ai samples/groups").startswith(
        "校准集的 AI 独立样本/组少于 30 个"
    )
