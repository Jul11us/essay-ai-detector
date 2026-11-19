# English accuracy benchmark

How to measure English false flags (human writing judged `high`) and misses (AI writing judged `low`) with the real `/api/detect` pipeline. The corpus is built from commit-pinned public data; essay text stays in the git-ignored `experiments/benchmark-private/` directory.

## Reproduce

```bash
python scripts/prepare_english_benchmark.py          # writes experiments/benchmark-private/public-en/
cd backend
D=../experiments/benchmark-private/public-en
python benchmark.py $D/manifest.jsonl --api http://127.0.0.1:8000 \
  --predictions-out $D/predictions.jsonl --out $D/report.json --calibration-out $D/calibration.json
```

Preparation downloads about 25 MB, checks every bulk file against a pinned SHA-256 and fails if a quota cannot be filled. Selection is a seeded hash order with length and language rules only (400–8,000 non-whitespace characters, Latin script); model scores are never read. Default seed `20261119` gives manifest SHA-256 `ab3afa90cd447f39032c5a0bcbf8717078e2b0e26ced901351c9c55960b3f77b`.

## Sources

| Domain | Label | Source (pinned commit) | Samples |
| --- | --- | --- | --- |
| Composition | human | [Ghostbuster](https://github.com/vivek3141/ghostbuster-data/tree/86ebd72590556a81622986fab736ab9227a948af/essay) IvyPanda essays, CC BY 3.0 | 120 |
| Composition | AI | Ghostbuster GPT-3.5 rewrites of the same 120 prompts (paired, same split) | 120 |
| Composition | AI | Ghostbuster Claude essays | 40 |
| Composition | human | [ELLIPSE](https://github.com/scrosseye/ELLIPSE-Corpus/tree/710963bbf1acf23a28e40643d9f937d06f047dd4) grade 8–12 English-learner essays, CC BY 4.0 | 120 |
| Composition | AI | [ArguGPT](https://github.com/huhailinguist/ArguGPT/tree/cfbd00e75b63db44756375cfc1ee4278f8cd2bf1) GPT-3.5 / GPT-4 / Claude-instant argumentative essays (TOEFL, WECCL, GRE prompts) | 40 each |
| Paper | human | [DetectRL](https://github.com/NLP2CT/DetectRL/tree/3472f0ae3cc81133c821e901f6d5c8f79c60dd23) arXiv abstracts | 120 |
| Paper | AI | DetectRL arXiv abstracts by ChatGPT, Claude-instant, PaLM-2, Llama-2-70b, across DetectRL's direct, prompt, paraphrase and adversarial-perturbation methods (`generation_method`) | 30 each |

ArguGPT and DetectRL ship no license file: use them for local evaluation only and do not redistribute samples. Every row carries `group_id` and a `calibration`/`test` split; paired Ghostbuster essays and ELLIPSE or ArguGPT essays sharing a prompt never cross splits. DetectRL does not link an abstract to its LLM versions, so all abstracts are `test` only and never fit thresholds.

## Results at the current thresholds (0.40 / 0.75)

Run on 2026-11-19 against the pinned Vanguard model (`sha256:713c8350…`), 760 documents. Intervals are 95% Wilson intervals.

| Domain | Label | n | Error | Uncertain |
| --- | --- | --- | --- | --- |
| Composition | human | 240 | 2 false flags, 0.8% (0.2–3.0%) | 18, 7.5% (4.8–11.5%) |
| Composition | AI | 280 | 1 miss, 0.4% (0.1–2.0%) | 8, 2.9% (1.5–5.5%) |
| Paper abstract | human | 120 | 0 false flags, 0.0% (0.0–3.1%) | 7, 5.8% (2.9–11.6%) |
| Paper abstract | AI | 120 | 15 misses, 12.5% (7.7–19.6%) | 76, 63.3% (54.4–71.4%) |

- Both false flags are ELLIPSE English-learner essays (2/120; scores 0.75 and 0.81). The native-writer Ghostbuster essays had none, and learners also produced most human `uncertain` results (15 of 18).
- Composition misses and uncertain results come mostly from Ghostbuster Claude essays (1 low, 6 uncertain of 40); GPT-3.5, GPT-4 and Claude-instant ArguGPT essays were flagged 159/160 times.
- 11 of the 15 abstract misses are paraphrase attacks (back-translation 9/17 low, DIPPER 2/10 low); the 19 direct-prompt AI abstracts had no misses.
- Paper abstracts are single paragraphs, so 155 of 240 have `low` confidence. Under the original coverage rule, 95 of 120 AI abstracts scored at least 0.75 but only 29 were flagged. The single-paragraph rule below fixes this; the table above shows results before that change.

## Single-paragraph English text

English documents with one scored paragraph of at least 400 non-whitespace characters can now be judged `high` (the same floor as the Chinese `genre=paper` exception). Confidence stays `low`, and the review note asks for a manual check. Shorter text and Chinese text without `genre=paper` are unchanged. Scores are unchanged too; only the verdict rule moved.

A separate test-only set checks the rule on single-paragraph text: 150 ELLIPSE learner essays, plus DetectRL news, story and review texts (60 human and 60 AI each). Build it with `python scripts/prepare_english_benchmark.py --set single-paragraph` (manifest SHA-256 `98318ef726d6e5c0578f372e529c3ad62216066694c5cc2c3cde5604235add72`).

| Set | Label | Before | After |
| --- | --- | --- | --- |
| arXiv abstracts (main set) | AI flagged `high` | 29/120 | 95/120 (79.2%, 71.1–85.5%) |
| arXiv abstracts (main set) | AI `uncertain` | 76/120 | 10/120 |
| arXiv abstracts (main set) | human false flags | 0/120 | 0/120 (0.0–3.1%) |
| Single-paragraph set | AI flagged `high` | 91/180 | 157/180 (87.2%, 81.6–91.3%) |
| Single-paragraph set | human false flags | 1/330 | 5/330 (1.5%, 0.6–3.5%) |

- The 4 new false flags are 3 of 60 human stories (5.0%, 1.7–13.7%) and 1 of 150 learner essays; each scored 0.89–0.97, with 683–898 characters.
- Compositions in the main set are multi-paragraph, so their counts did not change.
- A stricter bar for single paragraphs would trade detection for fewer false flags. At 0.95, both sets combined would have 1 false flag instead of 4 and 114 flagged AI texts instead of 132. That bar was read off these same samples, so it would need independent data before use.

## Limits

- AI text is from 2023-era generators; newer models are not covered.
- Human and AI compositions mostly come from different corpora (only Ghostbuster is paired), so corpus style can inflate the separation.
- ELLIPSE writers are US secondary-school learners, not Chinese students writing English.
- Training overlap is `unknown`. Vanguard's card lists DetectRL as out-of-distribution, but the other sources are not checked.
- The candidate calibration this run produces is not usable: correlated paired versions and unexcluded overlap keep it at `candidate`, and genre thresholds belong to the separate calibration work.
