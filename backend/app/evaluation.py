"""Local, stateless analysis of labelled document predictions.

No paths are read, no models are loaded, and no runtime threshold is changed.
"""
from __future__ import annotations

import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from benchmark import summarize
from calibration import build_profile, validate_split_groups

Short = Annotated[str, Field(min_length=1, max_length=500, strict=True)]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False, strict=True)]


class Sample(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: Short
    file: Annotated[str, Field(min_length=1, max_length=500)] | None = None
    lang: Literal["en", "zh"]
    label: Literal["human", "ai", "mixed"]
    source: Short
    source_url: Annotated[str, Field(max_length=2000)] | None = None
    license: Short = "unknown"
    split: Literal["calibration", "test", "descriptive"] = "descriptive"
    group_id: Short | None = None
    writer_group: Short = "unspecified"
    domain: Short = "unspecified"
    dataset_revision: Short | None = None
    generated_model: Short | None = None
    mixed_method: Short | None = None
    training_overlap: Literal["unknown", "possible", "excluded"] = "unknown"
    training_overlap_evidence: Annotated[str, Field(max_length=4000)] | None = None
    text_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")] | None = None

    @field_validator("id", "source", "group_id", "writer_group", "license", "domain")
    @classmethod
    def nonblank(cls, value):
        if value is not None and not value.strip():
            raise ValueError("字段不能为空白")
        return value

    @field_validator("file")
    @classmethod
    def relative_file(cls, value):
        if value is not None:
            parts = value.replace("\\", "/").split("/")
            if value.startswith(("/", "\\")) or ":" in value or ".." in parts:
                raise ValueError("样本文件名须是相对路径")
            if not value.lower().endswith((".txt", ".docx", ".pdf")):
                raise ValueError("样本须是 txt、docx 或文字版 PDF")
        return value

    @field_validator("source_url")
    @classmethod
    def public_link(cls, value):
        if value is not None:
            parsed = urlsplit(value)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("来源链接须是无登录信息的 HTTP(S) 地址")
        return value

    @model_validator(mode="after")
    def group_default(self):
        if self.group_id is None:
            self.group_id = self.id
        return self


class Prediction(Sample):
    score: Probability
    verdict: Literal["low", "uncertain", "high"]
    confidence: Literal["low", "medium", "high", "unknown"] = "unknown"
    model_id: Short = "unknown"
    model_revision: Annotated[str, Field(min_length=1, max_length=200)] = "unknown"
    char_count: Annotated[int, Field(ge=0, le=2_000_000, strict=True)] | None = None
    word_count: Annotated[int, Field(ge=0, le=2_000_000, strict=True)] | None = None
    latency_ms: Annotated[float, Field(ge=0, le=100_000_000, allow_inf_nan=False)] | None = None
    api_pipeline: Literal["/api/detect", "unspecified"] = "unspecified"
    input_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")] | None = None


class ManifestRequest(BaseModel):
    samples: Annotated[list[Sample], Field(min_length=1, max_length=1000)]


def validate_samples(samples: list[Sample]) -> list[dict]:
    records = [s.model_dump(exclude_none=True) for s in samples]
    if len({r["id"] for r in records}) != len(records):
        raise ValueError("样本编号重复，请给每份样本唯一编号。")
    validate_split_groups(records)
    return records


class AnalyzeRequest(BaseModel):
    records: Annotated[list[Prediction], Field(min_length=1, max_length=1000)]
    expected_sample_count: Annotated[int, Field(ge=1, le=1000, strict=True)] | None = None


def analyze_predictions(payload: AnalyzeRequest) -> dict:
    records = validate_samples(payload.records)
    expected = payload.expected_sample_count or len(records)
    if expected < len(records):
        raise ValueError("计划样本数不能少于完成样本数。")
    models: dict[str, tuple[str, str]] = {}
    for record in records:
        identity = record["model_id"], record["model_revision"]
        if record["lang"] in models and models[record["lang"]] != identity:
            raise ValueError("同一语言的样本必须使用同一模型及版本，请分开导入。")
        models[record["lang"]] = identity
        if record.get("input_sha256"):
            record["_sha256"] = record["input_sha256"]
    report = summarize(records, records)
    report["evaluation_run"] = {"expected": expected, "completed": len(records), "incomplete": expected != len(records)}
    # Require exact identity, not a display name masquerading as a weight fingerprint.
    profile = None
    if all(r["split"] in {"calibration", "test"} for r in records):
        profile = build_profile(report["records"])
        for lang, entry in profile["languages"].items():
            extra = []
            if expected != len(records):
                extra.append("evaluation incomplete: failed or cancelled samples are excluded")
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", entry["model_revision"]):
                extra.append("exact model weight fingerprint is unverified")
            if extra:
                entry["reasons"].extend(extra)
                if entry["status"] == "validated":
                    entry["status"] = "candidate"
    return {"report": report, "calibration": profile,
            "note": "根据提供的标签、来源和预测重新汇总；导入记录的真值和模型来源仍需人工核验。查看、拟合或导出不会自动启用阈值。"}
