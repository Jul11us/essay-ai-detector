import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

import html
import json
import time
from pathlib import Path
import torch
import transformers
from transformers import AutoTokenizer, AutoModelForSequenceClassification

root = Path(__file__).resolve().parent
model_path = root / 'models' / 'vanguard'
text = html.unescape((root / 'essay.txt').read_text(encoding='utf-8')).strip()
torch.set_num_threads(min(8, os.cpu_count() or 4))
print('Loading local Vanguard model', flush=True)
tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
model, loading = AutoModelForSequenceClassification.from_pretrained(
    model_path, local_files_only=True, attn_implementation='eager',
    reference_compile=False, output_loading_info=True,
)
if loading['missing_keys'] or loading['unexpected_keys'] or loading.get('mismatched_keys'):
    raise RuntimeError(f'Weight mismatch: {loading}')
model.eval()

def score(content):
    inputs = tokenizer(content, return_tensors='pt', truncation=False)
    count = inputs['input_ids'].shape[1]
    if count > model.config.max_position_embeddings:
        raise ValueError('Text exceeds context length')
    start = time.perf_counter()
    with torch.inference_mode():
        logits = model(**inputs).logits
    if logits.numel() != 1:
        raise ValueError(f'Expected single sigmoid logit, got {logits.shape}')
    return {'tokens': count, 'logit': logits.item(),
            'ai_score': torch.sigmoid(logits).item(),
            'seconds': round(time.perf_counter() - start, 3)}

result = {
    'model': 'ShantanuT01/vanguard-ai-text-detector',
    'revision': (model_path / 'revision.txt').read_text().strip(),
    'torch': torch.__version__, 'transformers': transformers.__version__,
    'preprocessing': 'HTML entity decoding only; no grammar edits; full text includes headings.',
    'word_count_whitespace': len(text.split()),
    'full_text': score(text),
}
print(json.dumps(result, indent=2), flush=True)
result['paragraphs'] = []
for index, paragraph in enumerate(text.split('\n\n')[2:], 1):
    entry = {'paragraph': index, **score(paragraph)}
    result['paragraphs'].append(entry)
    print(json.dumps(entry), flush=True)
(root / 'vanguard-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print('Saved vanguard-result.json', flush=True)
