import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.model_artifacts import MODEL_COMMITS, MODEL_IDS, MODEL_SHA256, matches_sha256


def download_vanguard(target: Path) -> None:
    repo, revision = MODEL_IDS["en"], MODEL_COMMITS["en"]
    target.mkdir(parents=True, exist_ok=True)
    for name, expected in MODEL_SHA256["en"].items():
        output = target / name
        if matches_sha256(output, expected):
            continue
        print(f"Downloading {name} at {revision}", flush=True)
        with NamedTemporaryFile(dir=target, suffix=".part", delete=False) as part:
            partial = Path(part.name)
        try:
            with urlopen(f"https://huggingface.co/{repo}/resolve/{revision}/{name}", timeout=60) as response:
                with partial.open("wb") as stream:
                    while chunk := response.read(4 * 1024 * 1024):
                        stream.write(chunk)
            if not matches_sha256(partial, expected):
                raise RuntimeError(f"SHA-256 mismatch: {name}")
            partial.replace(output)
        finally:
            partial.unlink(missing_ok=True)
    (target / "revision.txt").write_text(revision, encoding="utf-8")


if __name__ == "__main__":
    download_vanguard(Path(os.environ.get("VANGUARD_MODEL_PATH") or ROOT / "experiments/models/vanguard"))
    print("Download complete", flush=True)
