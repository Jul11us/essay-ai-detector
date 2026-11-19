"""Wait for both real models, not merely the early English-ready phase."""

import json
import time
import urllib.error
import urllib.request


def main() -> None:
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/api/status", timeout=5) as response:
                status = json.load(response)
            if all(status.get("models", {}).get(lang) is True for lang in ("en", "zh")):
                print(json.dumps(status))
                return
            if status.get("loading") is False:
                raise SystemExit(f"Models failed to load: {status}")
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(2)
    raise SystemExit("Timed out waiting for models.en and models.zh")


if __name__ == "__main__":
    main()
