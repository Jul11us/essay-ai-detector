# Features

The full description of each feature. For the project overview, how to read a score and setup, see the [README](README.en.md); the Chinese version is [features.md](features.md).

## Input, preview and export

This work-in-progress site runs locally. Paste text or upload a `.txt`, `.docx`, or text-based PDF to preview extracted content and examine an English or Chinese model signal. Mixed-language documents can be scored by language. The results include paragraph and sentence highlights, a document overview, passages to review, and exports to HTML, JSON, and CSV. Select several files at once to score them one by one into a summary table. Inference runs on your machine; essay text is not sent to a third-party scoring API.

## Batch detection

Batch runs retain completed results and local paragraph edits. Retry one failed file or all failures, cancel remaining files and continue later, and filter/sort the summary. Each file gets an automatic English, Chinese or bilingual language hint; unfinished files also allow a manual language choice. The 20-file limit rejects an oversized selection with a clear message instead of dropping files.

## Sample evaluation

The **Sample evaluation** panel imports prediction reports or runs labelled local files from a JSONL manifest. Filter by language, source, length, writer group and split, and inspect errors alongside uncertainty and Wilson intervals. Calibration uses disjoint groups; viewing, fitting or exporting a candidate does not activate it. See the [panel guide](evaluation-panel.md).

## Word annotation report

Export an editable **Word annotation report** for one language or both. It preserves the current result text, scored sentence colours, paragraph scores, ignored text and model/calibration notes. Pending or unmatched sentence scoring is disclosed; original file layout, images and footnotes are not reproduced. Downloads follow browser settings.

## Sentence review and notes

Click a scored sentence to review it alongside its context in a sticky sidebar, or a bottom drawer on mobile. Notes autosave, support undo, and can be marked reviewed, pending or needing revision. Word exports include native comments and a review log; HTML and JSON retain the reviews. Rechecking changed text clears its old annotations. Single-file previews allow paragraph selection, with body and abstract shortcuts. The server verifies the original file fingerprint and reports the selected and excluded text.

## Versions

Paragraph rechecks automatically create version records; you can also save named snapshots. Compare text additions, deletions and paragraph scores, with separate English and Chinese views. Restoring a snapshot keeps the previous result in history without rerunning inference. Each result retains its initial version and the most recent 19 records. Word exports the current result; JSON includes version history.

## Writing process timeline

The **Writing process timeline** records actual detection, paragraph rechecks, annotation changes, saved versions and restores. Filter events, inspect historical notes, or open a snapshot comparison. Consecutive edits to the same annotation state within 60 seconds are grouped into one node. Older version records are imported with their original save timestamps and labeled as historical. The timeline retains its starting point and the latest 199 nodes; snapshots have a separate 20-version limit. It does not track external editing, keystrokes or writing duration. Clearing a current annotation retains its historical timeline entry; deleting the task removes both. JSON includes the timeline; Word, HTML and CSV export only the current result.

## Task center

The **Task center** stores up to 50 detection, batch and evaluation jobs in this browser's IndexedDB, including input text, original files, results, versions and notes. Search names or original filenames, combine type and status filters, sort jobs, and rename them. Refreshing interrupts the queue; reopen a task and manually continue its unfinished items. Completed predictions are retained. Tasks can be deleted individually; clearing site data also removes them. Storage is specific to the browser and site address. See the [usage guide](review-tasks-scope.md).

## Screenshots

![Writing timeline with historical notes and saved versions](assets/writing-timeline.png)

![Local task center with search, filters and renaming](assets/task-center.png)

<img src="assets/sentence-detail.png" alt="Mobile sentence review drawer" width="360" />
