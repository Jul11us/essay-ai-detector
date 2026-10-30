"""`app` 包必须自给自足：Docker 镜像里只有 `backend/app`，没有 backend/ 根目录的脚本。

以前 `app/evaluation.py` 靠 `from benchmark import ...`、`from calibration import ...`
读 backend/ 根目录下的文件，只有工作目录恰好是 backend/ 时才导入得了，Dockerfile 还得
单独把这两个文件复制进去。
"""

import shutil
import subprocess
import sys
from pathlib import Path


def test_app_imports_with_nothing_but_the_app_package(tmp_path):
    shutil.copytree(
        Path(__file__).resolve().parents[1] / "app",
        tmp_path / "app",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    out = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import sys; sys.path.insert(0, '.'); import app.main; print('ok')",
        ],
        cwd=tmp_path,
        env={"DETECTOR_SKIP_LOAD": "1", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert out.stdout.strip() == "ok", out.stderr
