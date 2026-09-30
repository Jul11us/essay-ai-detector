import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.static import mount_frontend


@pytest.fixture
def client(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>spa</title>", encoding="utf-8")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    app = FastAPI()

    @app.get("/api/health")
    def health():
        return {"ok": True}

    mount_frontend(app, tmp_path)
    return TestClient(app)


def test_root_serves_the_built_index(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "<title>spa</title>" in r.text


def test_assets_are_served(client):
    assert client.get("/assets/app.js").text == "console.log(1)"


def test_api_routes_still_win_over_the_static_mount(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_missing_directory_fails_loudly(tmp_path):
    with pytest.raises(RuntimeError):
        mount_frontend(FastAPI(), tmp_path / "nope")


def test_real_app_serves_the_frontend_when_the_env_var_is_set(tmp_path, monkeypatch):
    """DETECTOR_STATIC_DIR 在导入 app.main 时生效，所以放进子进程里验证，别污染别的测试。"""
    import subprocess
    import sys
    import textwrap

    (tmp_path / "index.html").write_text("<title>built</title>", encoding="utf-8")
    code = textwrap.dedent(
        """
        from fastapi.testclient import TestClient
        from app.main import app
        c = TestClient(app)
        assert "<title>built</title>" in c.get("/").text
        assert c.get("/api/health").json() == {"ok": True}
        print("ok")
        """
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        env={**__import__("os").environ, "DETECTOR_STATIC_DIR": str(tmp_path), "DETECTOR_SKIP_LOAD": "1"},
        capture_output=True,
        text=True,
        cwd=__import__("pathlib").Path(__file__).resolve().parents[1],
    )
    assert out.stdout.strip() == "ok", out.stderr
