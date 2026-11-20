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

## Reference results before the sentence guard (0.40 / 0.75)

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

## Student/learner false-flag guards

The document verdict now has a conservative post-aggregation guard. An otherwise-`high` English result requires a **sentence-review median ≥0.30** to remain `high`; a lower median or no eligible scores yields `uncertain`. Low and uncertain results never change. The raw weighted document score, confidence, paragraph scores/bands and sentence values/highlights do not change. The Chinese default non-paper medium-confidence guard uses **0.925**, documented in [the Chinese benchmark](benchmark.md#学生作文误报保护仅调整全文档位); Chinese paper calibration is untouched.

Only otherwise-high English documents incur sentence inference. `run_detect` reuses `run_sentences`, exactly the UI's minimum of isolated/context-window scores, excludes `null` scores, and pools scored sentences across scoring paragraphs without weighting. Its existing per-paragraph cap still applies. Computed reviews are returned in the existing paragraph `sentences`/`sentenceNote` fields, so the UI does not request them again. There is no cross-request cache. Inference errors propagate rather than silently returning an unchecked high verdict.

Demotions include a machine-readable `verdict_adjustment` (`code`, `observed`, `threshold`, `original_verdict`, `verdict`, `note`, and English `scored_sentences`); otherwise it is `null`. Codes are `en_sentence_median_guard` and `zh_medium_high_guard`. The reason also appears in the existing reading/explanation. Frontend paragraph retests apply the same guards and retain fresh API sentence reviews; incomplete or failed full-document sentence coverage conservatively stays uncertain with a whole-document recheck instruction, rather than redisplaying an unguarded high. This does not change paragraph or sentence bands.

### Corpora and isolation

- **Existing composition dev/test:** the original deterministic public-en prompt/group split, mapping `calibration` to research `dev`: dev 123 humans (63 ELLIPSE learners, 60 Ghostbuster) /141 AI; test 117 humans (57 learners, 60 Ghostbuster) /139 AI. Ghostbuster/IvyPanda mixes high-school and university essays, without per-document native-language or school-level verification.
- **Extra ELLIPSE:** 400 held-out humans, seed `20261120`, excluding all public-en texts and learner-dev prompts; 28 test-only prompt groups. ELLIPSE is grade 8–12 learner writing, CC-BY-4.0, pinned at `710963bbf1acf23a28e40643d9f937d06f047dd4`.
- **PERSUADE 2.0:** 200 development and 200 test humans, explicit `ell_status=No`, known grade 6–12, discourse rows deduplicated by essay ID. [Official author revision](https://github.com/scrosseye/persuade_corpus_2.0/tree/5bdbad1175d1d5adec082b3f1c4e3ce37b7bd1bf) `5bdbad1175d1d5adec082b3f1c4e3ce37b7bd1bf` explicitly licenses data **CC-BY-4.0**. The author-linked Drive CSV is pinned by SHA-256 `f61319edd8bf16a982711ea0399fad59c05afaec05cdf0767f16a2c05c467e23`, not replaced by a mirror. **Non-ELL is a proxy, not evidence of native first language.** Dev happens to contain grade 8 across three prompts; test covers grades 6/8/9/10/11 across eleven prompts, not all grades or populations.
- **Cross-source prompt isolation:** PERSUADE dev uses only existing ELLIPSE-dev prompts; all other eligible prompts go to test. Shared group IDs and normalized-text hashes prevent cross-dev/test leakage. Combined English dev therefore includes both learners and non-ELL secondary students: 323 humans /141 AI.
- **Chinese and control:** C-ReD has 240 title-disjoint human/AI pairs per split, balanced across three AI generators, and unverified individual student authorship. HC3 uses `prepare_benchmark.py --pairs-per-language 50 --mixed-per-language 0 --seed 20261002`, never used to fit these rules.

Preparation (raw texts and generated artifacts must remain git-ignored):

```sh
python scripts/prepare_english_benchmark.py
python scripts/prepare_chinese_composition_benchmark.py
# Reference manifest: prior research rows, file paths relative to benchmark-private/,
# with ELLIPSE group_id=ellipse-prompt-<normalized prompt> and research split=dev/test.
python scripts/prepare_secondary_school_benchmark.py \
  --reference-manifest experiments/benchmark-private/student-rules/manifest.jsonl \
  --per-split 200 --seed 20261120
```

The secondary builder verifies source hashes, metadata, prompt assignment and normalized-text exclusions against that reference manifest, then records provenance in `persuade/preparation.json`. Reproducing the combined study also requires its private reference manifest; the secondary builder alone does not build the extra ELLIPSE cohort. No raw corpora are distributed with this repository.

### Implemented-path counts

Real `/api/detect` requests, same model fingerprints, calibration off. **Before** means latest main `52cb440`, including its merged English single-paragraph eligibility—not the old offline study. Each cell is **human high / AI high / AI uncertain / AI low**; dash means no AI examples.

| Corpus | Human/AI n | Before | Frozen guards |
| --- | ---: | --- | --- |
| Existing composition dev | 123/141 | 1/136/5/0 | 0/136/5/0 |
| PERSUADE dev | 200/0 | 6/—/—/— | 3/—/—/— |
| Existing composition test | 117/139 | 1/135/3/1 | 1/135/3/1 |
| PERSUADE test | 200/0 | 4/—/—/— | 3/—/—/— |
| Extra ELLIPSE test | 400/0 | 3/—/—/— | 1/—/—/— |
| HC3 English calibration | 25/25 | 1/23/0/2 | 0/21/2/2 |
| HC3 English test | 25/25 | 0/23/2/0 | 0/20/5/0 |
| C-ReD Chinese dev | 240/240 | 46/222/18/0 | 18/218/22/0 |
| C-ReD Chinese test | 240/240 | 33/206/34/0 | 10/203/37/0 |
| HC3 Chinese calibration | 25/25 | 0/0/25/0 | unchanged |
| HC3 Chinese test | 25/25 | 0/0/25/0 | unchanged |

All **2,480** actual API responses are compared against offline T/median-.30 recomputed with latest-main eligibility, including unchanged document scores and paragraph scores/bands. Per-document **newly-high humans = 0 in every corpus/split**, not just a net-count comparison. Private evidence: `student-rules/implemented-documents.jsonl`, `implemented-results.json`, and `implemented-api.log` under `experiments/benchmark-private/`.

An additional **120 DetectRL English paper humans** were checked through both latest-main and implemented `/api/detect`: 113 low /7 uncertain /0 high before and after, scores and paragraph bands identical. Including these controls, the source/language/split invariant covers **1,740 human documents in 14 cells**; see `implemented-paper-humans.jsonl` and `implemented-human-invariant.json`.

**Inherited differences, not created by these guards:** relative to the original study, latest-main eligibility changes 22 raw default verdicts (19 HC3 AI, one HC3 human, two PERSUADE test humans). Six are demoted by the frozen guards. The remaining **16 post-rule differences** are 15 HC3 AI (nine calibration, six test) and PERSUADE test human `persuade-en-81EFE876B2CE-human` (document .8809, sentence median .6223), all formerly uncertain and now high because of the already-merged single-paragraph feature. Its high is inherited, not newly introduced versus latest main. The private implemented-results file lists all 16 IDs separately.

**Gate trade-off:** latest-main HC3 English has 46/50 AI high and one human high; the guard gives **41/50 AI high and zero human high**. AI not-high misses rise **4→9**, exceeding the old +1 gate tolerance. Four newly eligible single-paragraph AI have sentence median below .30, in addition to the one AI lost in the old-eligibility study (27→26). The intentional `--record` baseline update makes this new operating point the regression reference; a subsequent gate pass does **not** erase this loss. Do not describe the old-study gate pass as a pass against latest-main defaults. Golden recording changes only the intended Chinese verdict and verdict-derived review risk, not model scores.

The actual fixed gate run passed on latest main, then printed `FAIL: en misses: 9 (baseline 4, tolerance +1)` with the guards against the old baseline. Chinese composition false flags fell **13→4** with all 40 AI still high; Chinese paper stayed at one human false flag and all 40 AI high. After the requested `accuracy_gate.py --record`, the gate printed `PASS: accuracy counts within baseline tolerance (+1 sample per metric/group)`. Sample/model fingerprints did not change. Before, pre-record failure and after outputs are retained as `gate-before.log`, `gate-pre-record.log`, and `gate-after.log`.

### Added latency to the document response

Three warm sequential paired loopback `/api/detect` calls, real CPU PyTorch models, two OMP/MKL threads per server, other model-scoring workers stopped. One pair per document; these are observations, not a latency percentile estimate. Scores/verdicts matched the bulk API pass.

| English document | Nonspace chars / paragraphs / scored sentences | Latest main | Guard | Added |
| --- | ---: | ---: | ---: | ---: |
| `en-ghostbuster-956-ai-gpt-3.5-turbo` | 6030 /11 /47 | 4.79 s | 34.92 s | **30.13 s** |
| `en-ghostbuster-554-ai-gpt-3.5-turbo` | 4969 /17 /37 | 4.57 s | 23.21 s | **18.65 s** |
| `en-ghostbuster-990-ai-gpt-3.5-turbo` | 4000 /8 /29 | 3.22 s | 17.26 s | **14.04 s** |

This puts sentence inference on the otherwise-high document response's critical path; previously the UI reviewed sentences asynchronously after the score arrived. Returning those same reviews avoids duplicate background inference, but does not eliminate the initial response delay. Non-high documents do not incur this sentence work. Evidence: `implemented-latency.json` and `.log`; all **333** otherwise-high English documents in the bulk pass returned exactly their original UI sentence values/notes, and other documents returned no precomputed reviews.

### Interpretation and limits

The frozen .30 rule predates PERSUADE; the newly dev-selected .40 and combination alternatives failed HC3 and were **not** implemented. This .30 rule removes some learner false flags while preserving all 271 existing English composition AI highs, but provides no held-out PERSUADE improvement relative to the old study (2→2; the latest-main inherited high makes the corresponding post-rule count 3). It is not a validated fairness guarantee for native English students or Chinese learners writing English.

Some English and HC3 outcomes had already been inspected; tests are not wholly pristine. Human/AI source confounding, limited grade/prompt coverage, unknown detector-training overlap, and unverified C-ReD individual authorship remain. Neither prompt isolation nor the PERSUADE non-ELL field establishes training independence or native L1. These guards only abstain from a high verdict; **scores are not authorship probabilities**.
