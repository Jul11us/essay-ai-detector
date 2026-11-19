"""Collect licensed, post-release paper candidates without reading detector scores.

Web authorship is a publication claim, not a verified no-AI attestation.
Raw responses and extracted texts remain under the git-ignored private root.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

from pypdf import PdfReader
from pypdf.errors import PyPdfError

REPO_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = REPO_ROOT / "experiments" / "benchmark-private"
DEFAULT_OUT = PRIVATE_ROOT / "independent"
SEEDS = Path(__file__).with_name("independent-seeds.jsonl")
USER_AGENT = "EssayIndependentEval/1.0 (+https://github.com/Jul11us/essay-ai-detector/issues)"
POLICY_VERSION = "independent-papers-v1"
CUTOFFS = {
    "en": {
        "at": "2026-07-18T18:49:59Z",
        "model_id": "ShantanuT01/vanguard-ai-text-detector",
        "commit": "823061be63b90f2b42f64ac1e1f82772e872533b",
        "evidence": "https://huggingface.co/api/models/ShantanuT01/vanguard-ai-text-detector/commits/823061be63b90f2b42f64ac1e1f82772e872533b",
    },
    "zh": {
        "at": "2025-06-24T23:49:44Z",
        "model_id": "yuchuantian/AIGC_detector_zhv3",
        "commit": "47695ff451b32c225dd938f4f478f7fdc6aa6bb0",
        "evidence": "https://huggingface.co/api/models/yuchuantian/AIGC_detector_zhv3/commits/47695ff451b32c225dd938f4f478f7fdc6aa6bb0",
    },
}
HOSTS = {"export.arxiv.org", "oaipmh.arxiv.org", "arxiv.org", "pdf.hanspub.org", "www.jto.ac.cn"}
MAX_BYTES = 25_000_000


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def iso(value: str) -> datetime:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}))?", value):
        raise ValueError("Expected ISO date or timezone-aware timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Fetcher:
    def __init__(self, out: Path, *, offline: bool = False, clock=time.time, sleep=time.sleep):
        self.raw = out / "raw"
        self.raw.mkdir(parents=True, exist_ok=True)
        self.offline, self.clock, self.sleep = offline, clock, sleep
        self.opener = urllib.request.build_opener(NoRedirect())
        self.state_path = self.raw / "rate-state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def request(self, url: str, delay: float) -> bytes:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.username or parsed.password or parsed.port:
            raise ValueError("URL is outside the collector's HTTPS source allowlist")
        key = digest(url)
        meta_path, body_path = self.raw / f"{key}.json", self.raw / f"{key}.bin"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            body = body_path.read_bytes()
            if meta["url"] != url or digest(body) != meta["sha256"]:
                raise ValueError("Cached response checksum mismatch")
            if meta["status"] != 200:
                raise ValueError(f"Cached HTTP {meta['status']}")
            return body
        if self.offline:
            raise ValueError("Offline cache miss")
        host = parsed.hostname
        api = host in {"export.arxiv.org", "oaipmh.arxiv.org"}
        rate_key = "arxiv-api" if api else host
        wait = max(self.state.get(rate_key, 0), self.state.get(f"last:{rate_key}", 0) + delay,
                   self.state.get(f"retry:{host}", 0)) - self.clock()
        if wait > 0:
            self.sleep(wait)
        self.state[rate_key] = self.clock() + delay
        self.state[f"last:{rate_key}"] = self.clock()
        self.state_path.write_text(json.dumps(self.state, sort_keys=True) + "\n")
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
        try:
            response = self.opener.open(request, timeout=90)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            status = response.code
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("Response exceeds 25 MB")
            retry = response.headers.get("Retry-After")
            if retry:
                try:
                    until = self.clock() + float(retry) if retry.isdigit() else parsedate_to_datetime(retry).timestamp()
                except (ValueError, TypeError, OverflowError):
                    until = self.clock() + 60
                self.state[f"retry:{host}"] = max(self.clock() + 60, until)
            elif status in {429, 503}:
                self.state[f"retry:{host}"] = self.clock() + 60
            self.state_path.write_text(json.dumps(self.state, sort_keys=True) + "\n")
            meta = {"url": url, "status": status, "sha256": digest(body),
                    "fetched_at": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(),
                    "content_type": response.headers.get("Content-Type"), "retry_after": retry}
            body_path.write_bytes(body)
            meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")
        if status != 200:
            raise ValueError(f"HTTP {status}; response cached, no automatic retry or redirect")
        return body

    def get(self, url: str) -> bytes:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname
        api = ((host == "export.arxiv.org" and parsed.path == "/api/query") or
               (host == "oaipmh.arxiv.org" and parsed.path == "/oai"))
        if host not in HOSTS:
            raise ValueError("Unsupported source host")
        # Dedicated APIs are governed by their published API terms, not crawler routes.
        if api:
            return self.request(url, 3)
        if host == "arxiv.org" and not parsed.path.startswith("/html/"):
            raise ValueError("Only versioned arXiv HTML is collected")
        delay = {"arxiv.org": 15, "pdf.hanspub.org": 60}.get(host, 3)
        robots_url = f"https://{host}/robots.txt"
        robots = self.request(robots_url, delay).decode("utf-8")
        policy = urllib.robotparser.RobotFileParser()
        policy.parse(robots.splitlines())
        if not policy.can_fetch(USER_AGENT, url):
            raise ValueError("robots.txt disallows this URL")
        delay = max(delay, policy.crawl_delay(USER_AGENT) or 0)
        return self.request(url, delay)


class Node:
    def __init__(self, tag: str, attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self, *, clean=False) -> str:
        classes = self.attrs.get("class", "").split()
        if self.tag in {"script", "style", "nav", "footer"}:
            return ""
        if clean and (self.tag in {"math", "table", "figure", "sup"} or
                      any(c in {"ltx_bibliography", "ltx_equation", "ltx_equationgroup", "ltx_tabular", "ltx_authors"} for c in classes)):
            return ""
        text = "".join(child.text(clean=clean) if isinstance(child, Node) else child for child in self.children)
        return text + ("\n\n" if self.tag in {"p", "div", "section", "h1", "h2", "h3", "li", "br"} else "")


class Document(HTMLParser):
    def __init__(self, raw: bytes):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]
        self.feed(raw.decode("utf-8"))

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in {"meta", "link", "img", "br", "hr", "input", "source", "wbr", "area", "base", "embed", "param", "col"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def meta(self, key: str) -> list[str]:
        return [n.attrs["content"].strip() for n in self.root.walk() if n.tag == "meta" and
                n.attrs.get("name", n.attrs.get("property", "")).lower() == key.lower() and n.attrs.get("content", "").strip()]


def license_notice(text: str) -> str | None:
    compact = re.sub(r"\s+", " ", text).lower()
    # Restricted licenses must never be misread as the permissive CC BY prefix.
    if re.search(r"cc[ -]?by[ -]?(?:nc|nd)|creativecommons\.org/licenses/by-(?:nc|nd)", compact):
        return None
    for pattern, name in (
        (r"creativecommons\.org/publicdomain/zero/1\.0|\bcc0(?:[ -]1\.0)?\b", "CC0-1.0"),
        (r"creativecommons\.org/licenses/by-sa/(\d\.\d)|\bcc[ -]by[ -]sa\s*(\d\.\d)\b", "CC-BY-SA"),
        (r"creativecommons\.org/licenses/by/(\d\.\d)|\bcc[ -]by\s*(\d\.\d)\b", "CC-BY"),
    ):
        match = re.search(pattern, compact)
        if match:
            return name if name == "CC0-1.0" else f"{name}-{next(g for g in match.groups() if g)}"
    return None


def ai_declaration(text: str) -> str:
    text = re.sub(r"\s+", " ", text).lower()
    no_ai = r"(?:the authors?|we|i) (?:declare that |confirm that |did )?(?:have not used|did not use|not use|used no) (?:any )?(?:generative ai|chatgpt|ai tools)|no generative ai (?:tools? )?(?:was|were) used|(?:本研究|本文|作者|本论文).{0,30}(?:未使用|没有使用|未曾使用|未采用)(?:任何)?(?:生成式人工智能|生成式ai|chatgpt|ai工具)"
    positive = r"(?:the authors?|we|i) (?:have |has )?used (?:generative ai|chatgpt|ai tools)|(?:本研究|本文|作者|本论文).{0,30}(?:使用了|采用了)(?:生成式人工智能|生成式ai|chatgpt|ai工具)"
    if re.search(positive, text):
        return "declared_ai_use"
    if re.search(no_ai, text):
        return "declared_no_ai"
    return "none_found"


def chinese_date(text: str, label: str) -> str | None:
    match = re.search(label + r"\s*[:：]?\s*(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})", text)
    if not match:
        return None
    year, month, day = map(int, match.groups())
    value = f"{year:04d}-{month:02d}-{day:02d}"
    iso(value)
    return value


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def parse_hans(raw: bytes, url: str) -> dict:
    reader = PdfReader(io.BytesIO(raw))
    if len(reader.pages) > 100:
        raise ValueError("PDF exceeds 100 pages")
    text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    # Hans repeats the named authors in the bibliographic citation on page one.
    authors = re.search(r"文章引用\s*[:：]\s*(.+?)\.", text, re.S)
    journal = re.search(r"hanspub\.org/journal/([a-z]+)", text, re.I)
    start = re.search(r"(?:^|\n)\s*1[.、]\s*[^\n]+", text)
    body = text[start.start():] if start else ""
    body = re.split(r"(?:^|\n)\s*参考文献", body)[0]
    return {"text": body.strip(), "notice": text, "authors": authors.group(1).strip() if authors else "",
            "first_version_at": chinese_date(text, "收稿日期"),
            "published_at": chinese_date(text, "发布日期"),
            "journal": f"Hans:{journal.group(1).lower()}" if journal else None,
            "date_basis": "received date (earlier drafts not independently verified)"}


def parse_jto(raw: bytes, url: str, body_raw: bytes | None = None) -> dict:
    doc = Document(raw)
    text = doc.root.text()
    body_doc = Document(body_raw) if body_raw else doc
    body = next((n for n in body_doc.root.walk() if n.attrs.get("id", "").lower() in
                 {"articlebody", "article_body", "fulltext", "full-text", "fulltext_content"}), None)
    if body is None:
        body = next((n for n in body_doc.root.walk() if "article" == n.tag), None)
    links = " ".join(n.attrs.get("href", "") for n in doc.root.walk() if n.attrs.get("rel") == "license")
    body_text = body.text(clean=True).strip() if body else ""
    body_text = re.split(r"(?:^|\n)\s*参考文献", body_text)[0]
    return {"text": body_text, "notice": text + " " + links,
            "authors": "; ".join(doc.meta("citation_author") or doc.meta("citation_authors")),
            "first_version_at": chinese_date(text, "收稿日期"),
            "published_at": chinese_date(text, "出版日期") or chinese_date(text, "发布日期"),
            "journal": "JTO", "date_basis": "received date (earlier drafts not independently verified)"}


def xml_values(raw: bytes, name: str) -> list[str]:
    root = ET.fromstring(raw)
    return ["".join(node.itertext()).strip() for node in root.iter() if node.tag.rsplit("}", 1)[-1] == name]


def discover_arxiv(fetcher: Fetcher, since: str, limit: int) -> tuple[list[dict], str]:
    start = iso(since).strftime("%Y%m%d%H%M")
    query = urllib.parse.urlencode({"search_query": f"submittedDate:[{start} TO 209912312359]",
                                    "start": 0, "max_results": min(200, max(10, limit * 4)),
                                    "sortBy": "submittedDate", "sortOrder": "ascending"})
    url = "https://export.arxiv.org/api/query?" + query
    root = ET.fromstring(fetcher.get(url))
    items = []
    for entry in root.findall("{http://www.w3.org/2005/Atom}entry"):
        identifier = entry.findtext("{http://www.w3.org/2005/Atom}id", "")
        match = re.fullmatch(r"https?://arxiv.org/abs/(\d{4}\.\d{4,5})(?:v\d+)?", identifier)
        if match:
            items.append({"url": f"https://arxiv.org/html/{match.group(1)}v1", "source": "arXiv", "arxiv_id": match.group(1)})
    return items, url


def parse_arxiv(fetcher: Fetcher, candidate: dict) -> tuple[dict, str]:
    identifier = candidate["arxiv_id"]
    base = "https://oaipmh.arxiv.org/oai?" + urllib.parse.urlencode({
        "verb": "GetRecord", "identifier": f"oai:arXiv.org:{identifier}"})
    metadata = fetcher.get(base + "&metadataPrefix=arXiv")
    history = fetcher.get(base + "&metadataPrefix=arXivRaw")
    root = ET.fromstring(history)
    version = next((n for n in root.iter() if n.tag.rsplit("}", 1)[-1] == "version" and n.attrib.get("version") == "v1"), None)
    if version is None:
        raise ValueError("Missing arXiv v1 history")
    dates = [n.text for n in version.iter() if n.tag.rsplit("}", 1)[-1] == "date" and n.text]
    if not dates:
        raise ValueError("Missing arXiv v1 date")
    try:
        first = iso(dates[0])
    except ValueError:
        first = parsedate_to_datetime(dates[0]).astimezone(timezone.utc)
    doc_raw = fetcher.get(candidate["url"])
    doc = Document(doc_raw)
    article = next((n for n in doc.root.walk() if n.tag == "article" and "ltx_document" in n.attrs.get("class", "").split()), None)
    authors = [" ".join("".join(n.itertext()).strip() for n in node)
               for node in ET.fromstring(metadata).iter() if node.tag.rsplit("}", 1)[-1] == "author"]
    licenses = xml_values(metadata, "license")
    # Require license confirmation in both metadata and the fetched v1 page.
    page_notice = re.search(r"License:\s*(CC[ A-Za-z0-9.-]+)", doc_raw.decode("utf-8"))
    page_license = license_notice(page_notice.group(1)) if page_notice else None
    meta_license = license_notice(" ".join(licenses))
    notice = " ".join(licenses) if page_license == meta_license else ""
    return {"text": article.text(clean=True).strip() if article else "", "notice": notice,
            "declaration_text": doc.root.text(), "authors": "; ".join(authors),
            "first_version_at": first.isoformat().replace("+00:00", "Z"),
            "published_at": first.isoformat().replace("+00:00", "Z"),
            "journal": "arXiv", "date_basis": "OAI arXivRaw v1 submission timestamp"}, digest(metadata + history + doc_raw)


def qualify(parsed: dict, lang: str, since: str | None = None) -> list[str]:
    reasons = []
    if not license_notice(parsed.get("notice", "")):
        reasons.append("missing_or_restricted_license")
    authors = normalize(parsed.get("authors", ""))
    if not authors or not re.search(r"[A-Za-z\u3400-\u9fff]", authors) or len(authors) > 4000:
        reasons.append("missing_named_authors")
    dates = {}
    for key in ("first_version_at", "published_at"):
        try:
            dates[key] = iso(parsed.get(key) or "")
        except (ValueError, TypeError):
            reasons.append(f"missing_or_invalid_{key}")
    first, published = dates.get("first_version_at"), dates.get("published_at")
    if first and first <= iso(CUTOFFS[lang]["at"]):
        reasons.append("first_version_not_after_pinned_release")
    if first and since and first < iso(since):
        reasons.append("first_version_before_since")
    if first and published and first > published:
        reasons.append("first_version_after_publication")
    if published and published > datetime.now(timezone.utc):
        reasons.append("future_publication")
    if ai_declaration(parsed.get("declaration_text", parsed.get("notice", ""))) == "declared_ai_use":
        reasons.append("declared_ai_use")
    text = parsed.get("text", "")
    if len(normalize(text)) < 400:
        reasons.append("missing_or_short_full_text")
    elif lang == "zh" and len(re.findall(r"[\u3400-\u9fff]", text)) / len(normalize(text)) < 0.3:
        reasons.append("not_chinese_full_text")
    elif lang == "en" and len(re.findall(r"[A-Za-z]", text)) / len(normalize(text)) < 0.5:
        reasons.append("not_english_full_text")
    if not parsed.get("journal"):
        reasons.append("missing_journal_identity")
    return reasons


def collect(out: Path, *, limit_en=10, limit_zh=20, since=None, offline=False, fetcher=None, seeds=SEEDS) -> dict:
    fetcher = fetcher or Fetcher(out, offline=offline)
    (out / "samples").mkdir(parents=True, exist_ok=True)
    audit, rows, seen = [], [], set()
    journals = Counter()
    candidates = []
    discovery_url = None
    if limit_en:
        try:
            en, discovery_url = discover_arxiv(fetcher, max(iso(since), iso(CUTOFFS["en"]["at"])).isoformat() if since else CUTOFFS["en"]["at"], limit_en)
            candidates.extend(("en", c) for c in en)
            if not en:
                audit.append({"source": "arXiv", "status": "rejected", "reasons": ["empty_discovery"]})
        except (ValueError, OSError, ET.ParseError) as exc:
            audit.append({"source": "arXiv", "status": "rejected", "reasons": [f"discovery_failed: {exc}"]})
    if limit_zh:
        candidates.extend(("zh", json.loads(line)) for line in seeds.read_text(encoding="utf-8").splitlines() if line.strip())
    accepted = Counter()
    for lang, candidate in candidates:
        if accepted[lang] >= {"en": limit_en, "zh": limit_zh}[lang]:
            audit.append({"source": candidate["source"], "url": candidate["url"], "status": "skipped", "reasons": ["language_limit_reached"]})
            continue
        url, source = candidate["url"], candidate["source"]
        item = {"source": source, "url": url, "lang": lang}
        try:
            if source == "arXiv":
                parsed, revision = parse_arxiv(fetcher, candidate)
            else:
                if not ((source == "Hans" and urllib.parse.urlsplit(url).hostname == "pdf.hanspub.org" and url.endswith(".pdf")) or
                        (source == "JTO" and urllib.parse.urlsplit(url).hostname == "www.jto.ac.cn")):
                    raise ValueError("Invalid seed source/URL")
                raw = fetcher.get(url)
                if source == "Hans":
                    parsed = parse_hans(raw, url)
                    revision = digest(raw)
                else:
                    rich = re.search(r"['\"](article/[^'\"]+\.shtml)['\"]", raw.decode("utf-8"))
                    body_raw = fetcher.get(urllib.parse.urljoin("https://www.jto.ac.cn/", rich.group(1))) if rich else None
                    parsed = parse_jto(raw, url, body_raw)
                    revision = digest(raw + (body_raw or b""))
            reasons = qualify(parsed, lang, since)
            normalized_hash = digest(normalize(parsed["text"]))
            if normalized_hash in seen:
                reasons.append("duplicate_normalized_text")
            cap = max(1, math.ceil(limit_zh * 0.5)) if lang == "zh" else limit_en
            if journals[parsed.get("journal")] >= cap:
                reasons.append("per_journal_cap")
            item.update(first_version_at=parsed.get("first_version_at"), published_at=parsed.get("published_at"),
                        raw_sha256=revision, normalized_text_sha256=normalized_hash,
                        journal=parsed.get("journal"), reasons=reasons)
            if not reasons:
                text = parsed["text"].strip() + "\n"
                item_id = f"independent-{lang}-{digest(url)[:16]}"
                filename = f"samples/{item_id}.txt"
                (out / filename).write_text(text, encoding="utf-8")
                cutoff = CUTOFFS[lang]
                rows.append({"id": item_id, "file": filename, "lang": lang, "label": "human", "domain": "paper",
                             "split": "test", "group_id": f"paper-{digest(url)[:24]}", "source": source,
                             "source_url": url, "license": license_notice(parsed["notice"]),
                             "dataset_revision": f"sha256:{revision}", "text_sha256": digest(text),
                             "writer_group": "web_publication_authors_unverified", "training_overlap": "excluded",
                             "training_overlap_evidence": f"{parsed['date_basis']}: {parsed['first_version_at']} > pinned commit {cutoff['commit']} ({cutoff['at']}); {cutoff['evidence']}. Temporal exclusion assumes no earlier draft/reused text; authorship is not independently verified.",
                             "author_names_sha256": digest(normalize(parsed["authors"])),
                             "first_version_at": parsed["first_version_at"], "published_at": parsed["published_at"],
                             "authorship_evidence": "publication_claim",
                             "ai_use_declaration": ai_declaration(parsed.get("declaration_text", parsed["notice"])),
                             "consent_reference": None})
                seen.add(normalized_hash)
                accepted[lang] += 1
                journals[parsed["journal"]] += 1
            item["status"] = "rejected" if reasons else "accepted"
        except (ValueError, OSError, ET.ParseError, PyPdfError) as exc:
            item.update(status="rejected", reasons=[f"fetch_or_parse_failed: {exc}"])
        audit.append(item)
    manifest = out / "manifest.jsonl"
    manifest.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows), encoding="utf-8")
    summary = {"schema_version": 1, "policy_version": POLICY_VERSION, "cutoffs": CUTOFFS,
               "user_agent": USER_AGENT, "discovery_url": discovery_url, "since": since,
               "limits": {"en": limit_en, "zh": limit_zh}, "max_zh_journal_share": 0.5,
               "seed_sha256": digest(seeds.read_bytes()), "manifest_sha256": digest(manifest.read_bytes()),
               "accepted": {"en": accepted["en"], "zh": accepted["zh"]},
               "counts": dict(Counter(c["status"] for c in audit)), "journals": dict(journals), "candidates": audit,
               "limitations": ["Publication claim only, not verified no-AI authorship or participant consent.",
                               "Received/submission dates do not rule out earlier drafts, copied passages or prior publication.",
                               "Human-only test papers cannot enable calibration; no detector scores used in selection.",
                               "Extraction omits references/math/tables where identified; inspect extraction before evaluation."]}
    (out / "preparation.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--limit-en", type=int, default=10)
    parser.add_argument("--limit-zh", type=int, default=20)
    parser.add_argument("--since", help="ISO date/timestamp; cannot relax either pinned-release cutoff")
    parser.add_argument("--offline", action="store_true", help="Rebuild using cached responses only")
    args = parser.parse_args()
    if min(args.limit_en, args.limit_zh) < 0:
        parser.error("Limits must be nonnegative")
    if not args.out.resolve().is_relative_to(PRIVATE_ROOT.resolve()):
        parser.error("Output must stay under experiments/benchmark-private/")
    if args.since:
        try:
            iso(args.since)
        except ValueError as exc:
            parser.error(str(exc))
    summary = collect(args.out, limit_en=args.limit_en, limit_zh=args.limit_zh, since=args.since, offline=args.offline)
    print(json.dumps({k: summary[k] for k in ("accepted", "counts", "manifest_sha256")}, sort_keys=True))


if __name__ == "__main__":
    main()
