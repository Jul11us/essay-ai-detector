"""把构建好的前端交给后端一起伺服，供单容器部署（Docker）用。开发时不启用。"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles


def mount_frontend(app: FastAPI, directory: Path) -> None:
    """挂在 `/`。必须在所有 API 路由注册完之后调用，否则静态文件会先于 `/api/*` 命中。

    目录不存在会直接报错：静默地不挂，容器起来后只会看到 404，更难排查。
    """
    app.mount("/", StaticFiles(directory=directory, html=True), name="frontend")
