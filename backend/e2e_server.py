"""端到端冒烟测试用的后端：真实的 FastAPI 接口，模型换成确定性的假打分。

不下载也不加载任何权重，所以 CI 里能跑。假打分只看标记词：段落里出现
"furthermore" 或 "此外" 就给高分，否则给低分。用法（在 backend/ 下）：

    python e2e_server.py
"""

from __future__ import annotations

import os

os.environ["DETECTOR_SKIP_LOAD"] = "1"

import uvicorn  # noqa: E402

from app.main import app, hub  # noqa: E402

HIGH_MARKERS = ("furthermore", "此外")


def fake_score(text: str, lang: str) -> float:
    lowered = text.lower()
    return 0.95 if any(m in lowered for m in HIGH_MARKERS) else 0.08


hub.loaded = {"zh": True, "en": True}
hub.phase, hub.detail = "ready", "测试用假模型已就绪"
# score_many 在没有真实模型时会退回逐条调用 self.score，所以只需要换 score。
hub.score = fake_score  # type: ignore[method-assign]

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("E2E_PORT", "8000")))
