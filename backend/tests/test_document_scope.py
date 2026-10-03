import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app, hub

BODY = "My brother and I walked to the lake after school. The water was cold, so we only put our feet in and watched the ducks. We talked about a trip we wanted to take next summer and who would bring the map. " * 2
ABSTRACT = "This abstract describes a different subject and should not enter the chosen body scope. " * 3
SOURCE = f"Abstract\n\n{ABSTRACT}\n\nIntroduction\n\n{BODY}\n\nReferences\n\nAuthor. A preserved bibliography entry."


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(hub, "loaded", {"en": True, "zh": True})
    seen = []
    monkeypatch.setattr(hub, "score", lambda text, lang: seen.append((text, lang)) or .2)
    return TestClient(app), seen


def upload(client, source=SOURCE):
    raw = source.encode()
    preview = client.post("/api/preview", files={"file": ("paper.txt", raw, "text/plain")}).json()
    return raw, preview


def test_selected_body_is_the_only_text_scored_and_exclusions_are_reported(client):
    api, seen = client
    raw, preview = upload(api)
    assert [b["section"] for b in preview["blocks"]] == ["摘要", "摘要", "正文", "正文", "参考文献", "参考文献"]
    response = api.post("/api/detect", files={"file": ("paper.txt", raw, "text/plain")}, data={"lang": "en", "selection": "[3]", "source_sha256": preview["source_sha256"]})
    assert response.status_code == 200
    assert seen and all("abstract" not in text and "bibliography" not in text for text, _ in seen)
    scope = response.json()["detection_scope"]
    assert scope["selected_blocks"] == 1 and scope["total_blocks"] == 6
    assert len(scope["excluded"]) == 5 and any(ABSTRACT.strip() == item["text"] for item in scope["excluded"])
    assert scope["source_sha256"] == hashlib.sha256(raw).hexdigest()


@pytest.mark.parametrize("selection", [[], [True], [-1], [900], [3, 3], "3", None])
def test_invalid_selection_is_rejected_without_inference(client, selection):
    api, seen = client
    raw, preview = upload(api)
    response = api.post("/api/detect", files={"file": ("paper.txt", raw, "text/plain")}, data={"lang": "en", "selection": json.dumps(selection), "source_sha256": preview["source_sha256"]})
    assert response.status_code == 400 and response.json()["error"] == "invalid_selection"
    assert not seen


def test_scope_cannot_be_reused_for_a_different_file(client):
    api, seen = client
    raw, preview = upload(api)
    response = api.post("/api/detect", files={"file": ("paper.txt", raw + b" changed", "text/plain")}, data={"lang": "en", "selection": "[3]", "source_sha256": preview["source_sha256"]})
    assert response.status_code == 400 and not seen


def test_scope_preview_keeps_blocks_beyond_the_display_excerpt(client):
    api, _ = client
    source = "A long paragraph for inspection. " * 200 + "\n\n" + BODY
    _, preview = upload(api, source)
    assert preview["truncated"] and len(preview["text"]) == 5000
    assert preview["scope_available"] and preview["blocks"][1]["text"] == BODY.strip()


def test_bilingual_scope_is_retained_on_both_language_reports(client):
    api, seen = client
    chinese = "社区图书馆请志愿者整理旧书，我们把小说和菜谱放回书架，并在一本书里找到手写纸条。管理员希望下一位读者也能看到这些生活中的小故事。" * 3
    raw, preview = upload(api, BODY + "\n\n" + chinese + "\n\nReferences\n\nExcluded source entry.")
    response = api.post("/api/detect", files={"file": ("paper.txt", raw, "text/plain")}, data={"lang": "bi", "selection": "[0,1]", "source_sha256": preview["source_sha256"]})
    assert response.status_code == 200
    result = response.json()
    assert {lang for _, lang in seen} == {"en", "zh"}
    assert result["detection_scope"]["selected_blocks"] == 2
    assert result["en"]["detection_scope"] == result["zh"]["detection_scope"]
