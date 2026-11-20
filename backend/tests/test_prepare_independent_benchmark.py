"""Network-free fixtures for licensed, post-release web paper collection."""
import importlib.util
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest

import benchmark

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_independent_benchmark.py"
_SPEC = importlib.util.spec_from_file_location("prepare_independent_benchmark", _SCRIPT)
prepare = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prepare)

ZH_BODY = "\n\n".join(["1. 引言", "本文讨论海洋生态监测方法与实验结果，记录现场采样及分析过程。" * 30, "2. 讨论", "科学观察需要独立的数据记录与方法检验。" * 20])
EN_BODY = "\n\n".join(["Introduction", "We describe observations, experimental measurements and independent analysis of the collected data. " * 30])
HANS = ("https://www.hanspub.org/journal/ojls\n收稿日期：2026年3月5日；录用日期：2026年3月18日；发布日期：2026年4月16日\n"
        "文章引用: 张三, 李四. 科学观察[J]. 法学, 2026, 14(4): 1-9.\n"
        "This work is licensed under the Creative Commons Attribution International License (CC BY 4.0).\n"
        + ZH_BODY.replace("海洋", "司法") + "\n参考文献\n不要复制此参考文献")


def jto(body=ZH_BODY):
    return (f'<html><head><meta name="citation_authors" content="张三, 李四"/></head><body>'
            f'<p>收稿日期:2025-07-04 出版日期:2026-05-10 发布日期:2026-05-28</p>'
            f'<a rel="license" href="https://creativecommons.org/licenses/by/4.0/">许可</a>'
            f'<div id="FullText">{body}</div></body></html>').encode()


def arxiv_html(body=EN_BODY, license="CC BY 4.0"):
    return (f'<html><head><title>Fixture paper</title></head><body><span title="License: {license}"></span>'
            f'<nav>PRIVATE NAVIGATION</nav><article class="ltx_document"><div class="ltx_authors">PRIVATE NAMES</div>'
            f'<section><p>{body}</p><math>PRIVATE MATH</math><table>PRIVATE TABLE</table></section>'
            f'<section class="ltx_bibliography">PRIVATE REFERENCES</section></article></body></html>').encode()


METADATA = b'<OAI><metadata><arXiv><authors><author><forenames>Alice</forenames><keyname>Smith</keyname></author></authors><license>http://creativecommons.org/licenses/by/4.0/</license></arXiv></metadata></OAI>'
HISTORY = b'<OAI><arXivRaw><version version="v1"><date>Sat, 29 Aug 2026 23:04:09 GMT</date></version><version version="v2"><date>Fri, 06 Nov 2026 10:00:00 GMT</date></version></arXivRaw></OAI>'
FEED = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2608.29463v2</id></entry></feed>'


class FixtureHTTP:
    def __init__(self, *, feed=FEED, metadata=METADATA, history=HISTORY):
        self.feed, self.metadata, self.history = feed, metadata, history
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        if url.startswith("https://export.arxiv.org/api/query?"):
            return self.feed
        if "metadataPrefix=arXivRaw" in url:
            return self.history
        if "metadataPrefix=arXiv" in url:
            return self.metadata
        if url == "https://arxiv.org/html/2608.29463v1":
            return arxiv_html()
        if url.startswith("https://www.jto.ac.cn/"):
            return jto()
        if url.startswith("https://pdf.hanspub.org/"):
            return b"fixture PDF, text supplied by mocked PdfReader"
        raise AssertionError(f"Unmocked HTTP request: {url}")


@pytest.fixture
def pdf(monkeypatch):
    monkeypatch.setattr(prepare, "PdfReader", lambda _: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: HANS)]))


@pytest.mark.parametrize("notice,expected", [
    ("CC BY 4.0", "CC-BY-4.0"), ("CC BY-SA 4.0", "CC-BY-SA-4.0"),
    ("https://creativecommons.org/licenses/by/3.0/", "CC-BY-3.0"),
    ("https://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0"),
    ("CC0", "CC0-1.0"), ("CC BY-NC 4.0", None), ("CC BY-ND 4.0", None),
    ("https://creativecommons.org/licenses/by-nc-sa/4.0/", None),
    ("All rights reserved", None), ("", None),
])
def test_license_notice(notice, expected):
    assert prepare.license_notice(notice) == expected


@pytest.mark.parametrize("text,expected", [
    ("The authors did not use any generative AI in this work.", "declared_no_ai"),
    ("No generative AI was used in preparing this manuscript.", "declared_no_ai"),
    ("本文未使用生成式人工智能辅助写作。", "declared_no_ai"),
    ("The authors used ChatGPT for language editing.", "declared_ai_use"),
    ("作者使用了生成式AI进行语言润色。", "declared_ai_use"),
    ("We used ChatGPT. No generative AI was used.", "declared_ai_use"),
    ("This paper studies generative AI tools in education.", "none_found"), ("", "none_found"),
])
def test_ai_declaration(text, expected):
    assert prepare.ai_declaration(text) == expected


@pytest.mark.parametrize("first,allowed", [
    ("2025-06-23", False), ("2025-06-24T23:49:44Z", False),
    ("2025-06-25", True), ("2025-07-04", True),
])
def test_dates_strictly_after_pinned_release(first, allowed):
    parsed = prepare.parse_jto(jto(), "https://www.jto.ac.cn/example")
    parsed["first_version_at"] = first
    reasons = prepare.qualify(parsed, "zh")
    assert ("first_version_not_after_pinned_release" not in reasons) is allowed


def test_english_cutoff_and_since_cannot_relax_release_gate():
    parsed, _ = prepare.parse_arxiv(FixtureHTTP(), {"arxiv_id": "2608.29463", "url": "https://arxiv.org/html/2608.29463v1"})
    parsed["first_version_at"] = "2026-07-18T18:49:59Z"
    assert "first_version_not_after_pinned_release" in prepare.qualify(parsed, "en", "2020-01-01")
    parsed["first_version_at"] = "2026-08-29"
    assert "first_version_before_since" in prepare.qualify(parsed, "en", "2026-09-01")


def test_missing_provenance_and_empty_body_reject_reasons():
    reasons = prepare.qualify({}, "zh")
    assert set(reasons) == {"missing_or_restricted_license", "missing_named_authors", "missing_or_invalid_first_version_at",
                            "missing_or_invalid_published_at", "missing_or_short_full_text", "missing_journal_identity"}
    parsed = prepare.parse_jto(jto(), "https://www.jto.ac.cn/example")
    parsed.update(first_version_at="2026-06-01", notice="CC BY 4.0. The authors used ChatGPT.")
    assert set(prepare.qualify(parsed, "zh")) == {"first_version_after_publication", "declared_ai_use"}


def test_pdf_dates_authors_body_and_license_come_from_content(pdf):
    parsed = prepare.parse_hans(b"fixture PDF", "https://pdf.hanspub.org/test.pdf")
    assert parsed["authors"] == "张三, 李四"
    assert parsed["first_version_at"] == "2026-03-05"
    assert parsed["published_at"] == "2026-04-16"
    assert parsed["journal"] == "Hans:ojls"
    assert "不要复制" not in parsed["text"]
    assert prepare.qualify(parsed, "zh") == []


def test_arxiv_checks_v1_history_and_drops_nonprose():
    http = FixtureHTTP()
    candidates, query = prepare.discover_arxiv(http, prepare.CUTOFFS["en"]["at"], 2)
    assert "submittedDate" in query
    assert candidates[0]["url"].endswith("2608.29463v1")
    parsed, revision = prepare.parse_arxiv(http, candidates[0])
    assert parsed["first_version_at"] == "2026-08-29T23:04:09Z"
    assert prepare.qualify(parsed, "en") == []
    assert "PRIVATE" not in parsed["text"]
    assert len(revision) == 64
    assert not any("/src" in u or "/e-print" in u for u in http.calls)
    with pytest.raises(ValueError, match="Missing arXiv v1"):
        prepare.parse_arxiv(FixtureHTTP(history=b"<OAI/>"), candidates[0])
    parsed, _ = prepare.parse_arxiv(FixtureHTTP(metadata=METADATA.replace(b"by/4.0", b"by-nc/4.0")), candidates[0])
    assert "missing_or_restricted_license" in prepare.qualify(parsed, "en")


def seed_file(tmp_path, sources):
    path = tmp_path / "seeds.jsonl"
    path.write_text("".join(json.dumps({"url": url, "source": source}) + "\n" for source, url in sources))
    return path


def test_collect_replay_deduplicates_and_manifest_passes_backend(tmp_path, pdf):
    seeds = seed_file(tmp_path, [("JTO", "https://www.jto.ac.cn/paper1"),
                                 ("JTO", "https://www.jto.ac.cn/paper2"),
                                 ("Hans", "https://pdf.hanspub.org/paper.pdf")])
    out = tmp_path / "out"
    http = FixtureHTTP()
    first = prepare.collect(out, limit_en=1, limit_zh=3, fetcher=http, seeds=seeds)
    rows = benchmark.load_manifest(out / "manifest.jsonl")
    assert first["accepted"] == {"en": 1, "zh": 2}
    assert any("duplicate_normalized_text" in c["reasons"] for c in first["candidates"])
    assert all(r["authorship_evidence"] == "publication_claim" and r["consent_reference"] is None for r in rows)
    assert all(r["split"] == "test" and r["label"] == "human" and r["training_overlap"] == "excluded" for r in rows)
    assert "张三" not in (out / "manifest.jsonl").read_text()
    assert "earlier drafts" in first["limitations"][1]
    second = prepare.collect(out, limit_en=1, limit_zh=3, fetcher=http, seeds=seeds, offline=True)
    assert first == second


def test_sample_hash_matches_file_bytes_with_windows_text_newlines(tmp_path, monkeypatch):
    write_text = Path.write_text
    def windows_write_text(path, text, *args, **kwargs):
        if path.parent.name == "samples":
            text = text.replace("\n", "\r\n")
        return write_text(path, text, *args, **kwargs)
    monkeypatch.setattr(Path, "write_text", windows_write_text)
    seeds = seed_file(tmp_path, [("JTO", "https://www.jto.ac.cn/paper1")])
    out = tmp_path / "out"
    prepare.collect(out, limit_en=0, limit_zh=1, fetcher=FixtureHTTP(), seeds=seeds)
    row = benchmark.load_manifest(out / "manifest.jsonl")[0]
    data = (out / row["file"]).read_bytes()
    assert row["text_sha256"] == hashlib.sha256(data).hexdigest()
    assert b"\n" in data and b"\r\n" not in data


@pytest.mark.parametrize("source", ["JTO", "Hans", "arXiv"])
def test_ai_use_in_full_text_is_checked_for_every_source(source, pdf):
    if source == "JTO":
        parsed = prepare.parse_jto(jto(), "https://www.jto.ac.cn/paper1")
    elif source == "Hans":
        parsed = prepare.parse_hans(b"fixture PDF", "https://pdf.hanspub.org/paper.pdf")
    else:
        parsed, _ = prepare.parse_arxiv(FixtureHTTP(), {"arxiv_id": "2608.29463", "url": "https://arxiv.org/html/2608.29463v1"})
    declaration = "The authors used ChatGPT for language editing."
    assert declaration not in parsed["notice"] + parsed.get("declaration_text", "")
    parsed["text"] += "\n" + declaration
    assert "declared_ai_use" in prepare.qualify(parsed, "en" if source == "arXiv" else "zh")


@pytest.mark.parametrize("declaration,expected", [
    ("The authors used ChatGPT for language editing.", "declared_ai_use"),
    ("The authors did not use any generative AI.", "declared_no_ai"),
    ("", "none_found"),
])
def test_jto_linked_body_declarations_control_acceptance_and_manifest(tmp_path, declaration, expected):
    class LinkedJTO(FixtureHTTP):
        def get(self, url):
            if url.endswith("/paper1"):
                return jto("") + b"<script>open('article/fixture.shtml')</script>"
            assert url == "https://www.jto.ac.cn/article/fixture.shtml"
            return jto(ZH_BODY + "\n" + declaration)
    seeds = seed_file(tmp_path, [("JTO", "https://www.jto.ac.cn/paper1")])
    out = tmp_path / "out"
    summary = prepare.collect(out, limit_en=0, limit_zh=1, fetcher=LinkedJTO(), seeds=seeds)
    if expected == "declared_ai_use":
        assert summary["accepted"]["zh"] == 0
        assert summary["candidates"][0]["reasons"] == ["declared_ai_use"]
        assert (out / "manifest.jsonl").read_bytes() == b""
    else:
        assert summary["accepted"]["zh"] == 1
        assert benchmark.load_manifest(out / "manifest.jsonl")[0]["ai_use_declaration"] == expected


def test_journal_cap_and_language_limit_are_audited(tmp_path):
    class DifferentPapers(FixtureHTTP):
        def get(self, url):
            return jto(ZH_BODY + url)
    seeds = seed_file(tmp_path, [("JTO", f"https://www.jto.ac.cn/paper{i}") for i in range(3)])
    summary = prepare.collect(tmp_path / "out", limit_en=0, limit_zh=2, fetcher=DifferentPapers(), seeds=seeds)
    assert summary["accepted"]["zh"] == 1
    assert summary["counts"] == {"accepted": 1, "rejected": 2}
    assert all("per_journal_cap" in c["reasons"] for c in summary["candidates"][1:])


def test_discovery_failure_empty_feed_and_source_errors_are_audited(tmp_path):
    seeds = seed_file(tmp_path, [("JTO", "https://other.example/paper")])
    summary = prepare.collect(tmp_path / "out", limit_en=1, limit_zh=1, seeds=seeds,
                              fetcher=FixtureHTTP(feed=b'<feed xmlns="http://www.w3.org/2005/Atom"/>'))
    assert summary["accepted"] == {"en": 0, "zh": 0}
    assert summary["candidates"][0]["reasons"] == ["empty_discovery"]
    assert "Invalid seed" in summary["candidates"][1]["reasons"][0]
    class BrokenHTTP:
        def get(self, url):
            raise OSError("fixture timeout")
    summary = prepare.collect(tmp_path / "out", limit_en=1, limit_zh=0, seeds=seeds, fetcher=BrokenHTTP())
    assert "discovery_failed: fixture timeout" in summary["candidates"][0]["reasons"]


class Response(io.BytesIO):
    def __init__(self, body, code=200, headers=None):
        super().__init__(body)
        self.code, self.headers = code, headers or {}


class Opener:
    def __init__(self, clock, responses):
        self.clock, self.responses, self.calls = clock, responses, []

    def open(self, request, timeout):
        self.calls.append((request.full_url, self.clock(), dict(request.header_items())))
        response = self.responses[request.full_url]
        if isinstance(response, Exception):
            raise response
        return Response(*response)


def test_fetcher_robots_spacing_persistent_cache_and_offline(tmp_path):
    now, sleeps = [1000.0], []
    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds
    fetcher = prepare.Fetcher(tmp_path, clock=lambda: now[0], sleep=sleep)
    url = "https://pdf.hanspub.org/paper.pdf"
    fetcher.opener = Opener(lambda: now[0], {
        "https://pdf.hanspub.org/robots.txt": (b"User-agent: *\nAllow: /\nCrawl-delay: 60\n",),
        url: (b"fixture PDF",),
    })
    assert fetcher.get(url) == b"fixture PDF"
    assert sleeps == [60]
    assert "EssayIndependentEval" in fetcher.opener.calls[0][2]["User-agent"]
    offline = prepare.Fetcher(tmp_path, offline=True)
    assert offline.get(url) == b"fixture PDF"
    assert len(fetcher.opener.calls) == 2
    with pytest.raises(ValueError, match="cache miss"):
        offline.get("https://pdf.hanspub.org/missing.pdf")
    body_path = fetcher.raw / f"{prepare.digest(url)}.bin"
    body_path.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="checksum"):
        offline.get(url)


def test_fetcher_blocks_robots_redirect_and_429_obeys_retry_after(tmp_path):
    now = [1000.0]
    fetcher = prepare.Fetcher(tmp_path, clock=lambda: now[0], sleep=lambda s: now.__setitem__(0, now[0] + s))
    fetcher.opener = Opener(lambda: now[0], {
        "https://arxiv.org/robots.txt": (b"User-agent: *\nDisallow: /html/\n",),
        "https://export.arxiv.org/api/query?one": HTTPError("fixture", 429, "Limited", {"Retry-After": "120"}, io.BytesIO(b"limited")),
        "https://oaipmh.arxiv.org/oai?two": (b"<OAI/>",),
        "https://oaipmh.arxiv.org/oai?redirect": (b"", 302, {"Location": "https://other.example"}),
    })
    with pytest.raises(ValueError, match="robots.txt disallows"):
        fetcher.get("https://arxiv.org/html/2608.29463v1")
    with pytest.raises(ValueError, match="Only versioned"):
        fetcher.get("https://arxiv.org/src/2608.29463")
    with pytest.raises(ValueError, match="HTTP 429"):
        fetcher.get("https://export.arxiv.org/api/query?one")
    assert fetcher.get("https://oaipmh.arxiv.org/oai?two") == b"<OAI/>"
    assert fetcher.opener.calls[-1][1] >= 1003
    # The retry deadline is host-specific and survives a new process.
    assert json.loads(fetcher.state_path.read_text())["retry:export.arxiv.org"] == 1120
    with pytest.raises(ValueError, match="HTTP 302"):
        fetcher.get("https://oaipmh.arxiv.org/oai?redirect")
    with pytest.raises(ValueError, match="Unsupported"):
        fetcher.get("https://other.example/paper")


def test_real_seed_list_is_urls_only_unique_and_has_both_sources():
    seeds = [json.loads(line) for line in prepare.SEEDS.read_text().splitlines()]
    assert len(seeds) == 40
    assert len({s["url"] for s in seeds}) == 40
    assert all(set(s) == {"source", "url"} for s in seeds)
    assert {s["source"] for s in seeds} == {"Hans", "JTO"}
