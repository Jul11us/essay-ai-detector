import json
import os
import urllib.request
from pathlib import Path

repo = 'ShantanuT01/vanguard-ai-text-detector'
with urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}', timeout=60) as r:
    revision = json.load(r)['sha']
# 和后端 loader 用同一个环境变量；Docker 里权重放在挂载的卷上。
target = Path(os.environ.get('VANGUARD_MODEL_PATH') or Path(__file__).resolve().parent / 'models' / 'vanguard')
target.mkdir(parents=True, exist_ok=True)
(target / 'revision.txt').write_text(revision, encoding='utf-8')
for name in ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'model.safetensors']:
    output = target / name
    if output.exists():
        continue
    print(f'Downloading {name} at {revision}', flush=True)
    req = urllib.request.Request(f'https://huggingface.co/{repo}/resolve/{revision}/{name}')
    with urllib.request.urlopen(req, timeout=60) as r, output.with_suffix(output.suffix + '.part').open('wb') as f:
        total = 0
        last = 0
        while chunk := r.read(4 * 1024 * 1024):
            f.write(chunk)
            total += len(chunk)
            if total - last >= 100 * 1024 * 1024:
                print(f'{name}: {total / 1024**2:.0f} MiB', flush=True)
                last = total
    output.with_suffix(output.suffix + '.part').replace(output)
print('Download complete', flush=True)
