import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

const BODY = "My brother and I walked to the lake after school. The water was cold, so we only put our feet in and watched the ducks. We talked about a trip we wanted to take next summer and who would bring the map. ".repeat(2);
const ABSTRACT = "This abstract describes a different subject and should not enter the chosen body scope. ".repeat(3);
const SOURCE = `Abstract\n\n${ABSTRACT}\n\nIntroduction\n\n${BODY}\n\nReferences\n\nAuthor. A preserved bibliography entry.`;
const file = (name: string, text = BODY) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
}
async function tasks(page: Page) {
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByText("已保存到本机", { exact: true })).toBeVisible();
}
async function exported(page: Page) {
  await page.getByText("更多导出", { exact: true }).click();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8")).result;
}

test("sentence reviews survive refresh, reach Word and clear after the sentence changes", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "英文演示", exact: true }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  const sentence = page.locator("button.sent-button").first();
  await expect(sentence).toBeVisible();
  const initial = await exported(page);
  await sentence.click();
  await page.getByLabel("人工复核状态", { exact: true }).selectOption("reviewed");
  await page.getByLabel("人工复核批注", { exact: true }).fill("核对了草稿与引用，保留这句。<原文>");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(page.locator(".review-editor")).toContainText("已保存");
  let wordBody: Record<string, unknown> = {};
  page.on("request", (request) => { if (request.url().endsWith("/api/reports/word")) wordBody = request.postDataJSON(); });
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 Word 标注报告", exact: true }).click();
  expect((await waiting).suggestedFilename()).toMatch(/\.docx$/);
  expect(JSON.stringify(wordBody)).toContain("核对了草稿与引用");
  await tasks(page);
  await expect(page.locator(".task-item")).toContainText("1 / 1 份完成");
  await page.reload();
  await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toContainText("已复核");
  const restored = await exported(page);
  expect(restored.score).toBe(initial.score);
  expect(restored.paragraphs[0].sentences[0].review.note).toContain("核对了草稿");
  const paragraph = page.locator("li.para").first();
  await paragraph.getByRole("button", { name: "在此修改并重测本段" }).click();
  await paragraph.getByLabel("修改第 1 段").fill(BODY);
  await paragraph.getByRole("button", { name: "重测这一段" }).click();
  await expect(paragraph.getByRole("button", { name: "在此修改并重测本段" })).toBeFocused();
  await expect(paragraph.locator("button.sent-button").first()).toBeVisible();
  expect(JSON.stringify((await exported(page)).paragraphs[0])).not.toContain("核对了草稿");
  await tasks(page);
  await page.getByRole("button", { name: "删除任务", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator(".task-item")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "等待你的第一份任务" })).toBeVisible();
});

test("reviews remain on the correct batch file after switching and restoring the task", async ({ page }) => {
  await ready(page);
  await page.locator('.input-panel input[type="file"]').setInputFiles([file("first.txt"), file("second.txt", BODY + " We brought a different map.")]);
  await page.getByRole("button", { name: "批量检测 2 个文件", exact: true }).click();
  await expect(page.getByText("共 2 个文件 · 完成 2 · 失败 0 · 已取消 0")).toBeVisible();
  await page.getByRole("button", { name: "查看 first.txt 的逐句结果", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();
  await page.locator("button.sent-button").first().click();
  await page.getByLabel("人工复核状态").selectOption("revise");
  await page.getByLabel("人工复核批注").fill("第一份文件需要补充原稿依据。");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await page.getByRole("button", { name: "查看 second.txt 的逐句结果", exact: true }).click();
  await expect(page.locator(".sentence-review-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "查看 first.txt 的逐句结果", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toContainText("需修改");
  await tasks(page); await page.reload(); await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  await page.getByRole("button", { name: "查看 first.txt 的逐句结果", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toContainText("需修改");
  await page.locator("button.sent-button").first().click();
  await expect(page.getByLabel("人工复核批注")).toHaveValue("第一份文件需要补充原稿依据。");
});

test("chosen scope is enforced by the API and restores with the source file", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "英文", exact: true }).click();
  await page.locator('.input-panel input[type="file"]').setInputFiles(file("paper.txt", SOURCE));
  await page.getByText("选择检测范围 · 已选 6 / 6 段", { exact: true }).click();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始检测", exact: true })).toBeDisabled();
  await page.getByLabel("检测提取第 4 段", { exact: true }).check();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.getByText("实际检测范围：1 / 6 个提取段落", { exact: true })).toBeVisible();
  const result = await exported(page);
  expect(result.paragraphs.map((p: {text: string}) => p.text).join("\n")).toContain("My brother");
  expect(result.paragraphs.map((p: {text: string}) => p.text).join("\n")).not.toContain("abstract describes");
  expect(result.detection_scope.excluded).toHaveLength(5);
  expect(result.detection_scope.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  await tasks(page); await page.reload(); await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  await expect(page.getByText("选择检测范围 · 已选 1 / 6 段", { exact: true })).toBeVisible();
  await expect(page.getByLabel("文件提取文字预览")).toHaveValue(/abstract describes/);
  await page.getByText("选择检测范围 · 已选 1 / 6 段", { exact: true }).click();
  await expect(page.getByLabel("检测提取第 4 段", { exact: true })).toBeChecked();
  const paragraph = page.locator("li.para").first();
  await paragraph.getByRole("button", { name: "在此修改并重测本段" }).click();
  await paragraph.getByLabel("修改第 1 段").fill(BODY + " We returned before the rain.");
  await paragraph.getByRole("button", { name: "重测这一段" }).click();
  await expect(paragraph.getByRole("button", { name: "在此修改并重测本段" })).toBeFocused();
  expect((await exported(page)).detection_scope.note).toContain("正文已在复核中修改");
});

test("refreshing an active batch retains completed files and resumes only unfinished ones", async ({ page }) => {
  await ready(page);
  let calls = 0; let release!: () => void;
  await page.route("**/api/detect", async (route) => {
    calls++;
    if (calls === 2) await new Promise<void>((resolve) => { release = resolve; });
    try { await route.continue(); } catch { /* The refresh aborts the interrupted request. */ }
  });
  await page.locator('.input-panel input[type="file"]').setInputFiles([file("a.txt"), file("b.txt"), file("c.txt")]);
  await page.getByRole("button", { name: "批量检测 3 个文件", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await tasks(page);
  await expect(page.locator(".task-item")).toContainText("1 / 3 份完成");
  await page.reload(); release(); await tasks(page);
  await page.getByRole("button", { name: "打开并继续", exact: true }).click();
  await expect(page.getByText("共 3 个文件 · 完成 1 · 失败 0 · 已取消 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续检测 2 个未完成文件", exact: true }).click();
  await expect(page.getByText("共 3 个文件 · 完成 3 · 失败 0 · 已取消 0", { exact: true })).toBeVisible();
  expect(calls).toBe(4);
});

test("evaluation restores its files and records after refresh without duplicating predictions", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "样本评测", exact: true }).click();
  const samples = ["a", "b", "c"].map((id) => ({ id, file: `${id}.txt`, lang: "en", label: "human", source: "Synthetic fixture", split: "descriptive" }));
  await page.getByLabel("导入样本清单", { exact: true }).setInputFiles({ name: "manifest.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(samples)) });
  await expect(page.getByText(/清单 3 份/)).toBeVisible();
  await page.getByLabel("选择评测样本文件", { exact: true }).setInputFiles(samples.map((s) => file(s.file)));
  let calls = 0; let release!: () => void;
  await page.route("**/api/detect", async (route) => {
    calls++;
    if (calls === 2) await new Promise<void>((resolve) => { release = resolve; });
    try { await route.continue(); } catch { /* Refresh aborts the active request. */ }
  });
  await page.getByRole("button", { name: "开始样本评测", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await tasks(page); await expect(page.locator(".task-item")).toContainText("1 / 3 份完成");
  await page.reload(); release(); await tasks(page);
  await page.getByRole("button", { name: "打开并继续", exact: true }).click();
  await expect(page.getByText(/清单 3 份 · 已选择文件 3 份/)).toBeVisible();
  await page.getByRole("button", { name: "继续未完成样本", exact: true }).click();
  await expect(page.getByText("已载入 3 份预测 · 1 个来源", { exact: true })).toBeVisible();
  expect(calls).toBe(4);
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出评测报告", exact: true }).click();
  const result = JSON.parse(await readFile((await (await waiting).path())!, "utf8"));
  expect(result.report.records.map((r: {id: string}) => r.id)).toEqual(["a", "b", "c"]);
  expect(result.report.evaluation_run.incomplete).toBe(false);
});

test("scope, review controls and task center fit mobile and remain accessible", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 }); await ready(page);
  await page.getByRole("button", { name: "英文", exact: true }).click();
  await page.locator('.input-panel input[type="file"]').setInputFiles(file("paper.txt", SOURCE));
  await page.getByText("选择检测范围 · 已选 6 / 6 段", { exact: true }).click();
  await page.getByRole("button", { name: "仅正文", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();
  await page.locator("button.sent-button").first().click();
  const violations = async () => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze()).violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target) }));
  expect(await violations()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("scope-review-mobile.png"), fullPage: true });
  await page.getByRole("button", {name:"收起句子说明",exact:true}).click();
  await tasks(page);
  expect(await violations()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("task-center-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("task-center-desktop.png"), fullPage: true });
});
