<div align="center">
  <img src="assets/logo.svg" alt="Essay AI Detector logo" width="86" />
  <h1>Essay AI Detector</h1>
  <p>A local preview for examining model signals in English and Chinese writing.</p>
  <p><strong>Local preview · Not deployed · Scores are not calibrated</strong></p>
  <p><a href="../README.md">简体中文</a> · <a href="#get-started">Get started</a> · <a href="features.en.md">Features</a> · <a href="benchmark.md">Evaluation notes</a> · <a href="../CHANGELOG.md">Changelog</a></p>
</div>

![Local demo with synthetic example text](assets/overview.png)

> Screenshots come from browser workflow tests using fictional text and a deterministic test model. Scores illustrate the interface, not real model performance, measured accuracy, or known authorship labels.

## What it does

This work-in-progress site runs locally. Paste text or upload a `.txt`, `.docx`, or text-based PDF to preview extracted content and examine an English or Chinese model signal. Mixed-language documents can be scored by language. Inference runs on your machine; essay text is not sent to a third-party scoring API.

- **Results**: paragraph and sentence highlights, a document overview, and passages to review.
- **Batch**: up to 20 files at once, scored one by one into a summary table; failures can be retried and the run cancelled.
- **Review**: a sticky context sidebar, reviewed/pending/needs-revision marks, autosaved notes.
- **Export**: an editable Word annotation report, HTML, JSON and CSV.
- **Versions, timeline, task center**: paragraph rechecks are versioned and comparable; actions can be replayed; tasks persist in this browser.
- **Sample evaluation**: errors, uncertainty and Wilson intervals on labelled samples; candidate thresholds stay inactive until independently validated.

See [Features](features.en.md) for details, limits and screenshots.

## How to interpret a result

The output is a **writing-pattern signal**, not the percentage of words written by AI, evidence of misconduct, or a prediction of a school's decision. Display thresholds are provisional. The project does not yet have a representative, labeled evaluation set from which it could publish an accuracy or false-positive rate. Short texts, non-native English writing, edited text, and new domains need careful human review. See the [evaluation notes](benchmark.md).

The reproducible [public HC3 pilot](benchmark-dataset.md) uses pinned bilingual human/ChatGPT Q&A pairs, not student essays. Evaluation runs the actual local API and reports errors, uncertainty, source groups and Wilson intervals. Threshold fitting uses only calibration groups, with disjoint test groups; unverified training overlap, insufficient samples or failed test constraints keep a profile inactive. Scores remain raw model signals, and paragraph/sentence thresholds are not calibrated by document-level data.

## Get started

Use Windows, Python 3.11+, and Node.js 20.19+. Run from the repository root in PowerShell:

```powershell
py -3 -m venv .venv-detector
.\.venv-detector\Scripts\python.exe -m pip install -r backend\requirements.txt
npm --prefix frontend ci
.\.venv-detector\Scripts\python.exe experiments\download_model.py
.\打开.bat
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and wait for the English-ready indicator. The Chinese model downloads on first use. Run `停止.bat` when finished. Model weights, virtual environments, private essays, and local evaluation outputs are excluded from this repository.

For development and tests, see [local-development.md](local-development.md). The service is **not deployed online**. Account, usage-limit, and payment features are not implemented.

## License

The project's source code is released under the [MIT License](../LICENSE). The license covers this repository's code only: the model weights (English Vanguard, Chinese zhv3) are not included and each has its own license on its model page. Check those terms separately before any commercial or hosted use. Open-sourcing the code does not change the limits on how to read the scores.
