"""请求体大小上限，按实际收到的字节数算，不只看 Content-Length。

Content-Length 是客户端自报的：分块传输（chunked）根本不带它，谎报的也拦不住。
这里包住 ASGI 的 `receive`，边读边数；超限就在读取处抛 `DetectError`，由
应用已注册的异常处理器统一回成 JSON。所以 `request.json()`、`request.form()`
和分块上传都走同一道闸，不会把超大请求体整个读进内存或临时文件。
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from app.errors import DetectError


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, *, limit: int, multipart_slack: int = 0) -> None:
        self.app = app
        self.limit = limit
        # multipart 除文件本身外还有 boundary / 表单字段，留一点余量。
        self.multipart_slack = multipart_slack

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        cap = self.limit
        if "multipart/form-data" in headers.get("content-type", ""):
            cap += self.multipart_slack
        declared = headers.get("content-length")
        too_big = bool(declared and declared.isdigit() and int(declared) > cap)
        seen = 0

        async def guarded_receive():
            nonlocal seen
            # 自报超限：连第一块都不读。
            if too_big:
                raise DetectError("payload_too_large")
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > cap:
                    raise DetectError("payload_too_large")
            return message

        await self.app(scope, guarded_receive, send)
