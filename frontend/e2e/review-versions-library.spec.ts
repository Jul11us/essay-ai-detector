import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

const BODY =
  "My brother and I walked to the lake after school. The water was cold, so we only put our feet in and watched the ducks. We talked about a trip we wanted to take next summer and who would bring the map. ".repeat(
    2,
  );
const file = (name: string, text = BODY) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(text),
});
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
}
async function single(page: Page, name = "Original-paper.txt") {
  await page.getByRole("button", { name: "英文", exact: true }).click();
  await page.locator('.input-panel input[type="file"]').setInputFiles(file(name));
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();
}
async function tasks(page: Page) {
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByText("已保存到本机", { exact: true })).toBeVisible();
}
async function exported(page: Page) {
  await page.locator(".result .export-menu summary").first().click();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  return JSON.parse(await readFile((await (await waiting).path())!, "utf8")).result;
}
async function panel(page: Page) {
  const p = page.locator(".version-panel");
  if (!(await p.evaluate((el) => (el as HTMLDetailsElement).open)))
    await p.locator("summary").click();
  await expect(p.getByLabel("左侧版本")).toBeVisible();
  return p;
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function accessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
        .analyze()
    ).violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
}

test("fixed review pane keeps manuscript position, autosaves on next sentence and undoes clearing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await single(page);
  const sentence = page.locator("button.sent-button").first(),
    paragraph = page.locator("li.para").first();
  const before = (await paragraph.boundingBox())!;
  const initial = (await exported(page)).score;
  await sentence.click();
  await expect(page.getByRole("region", { name: "句子复核", exact: true })).toBeVisible();
  const after = (await paragraph.boundingBox())!;
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  await page.getByLabel("人工复核批注").fill("核对手稿与引用，保留原句。");
  await page.getByLabel("人工复核状态").selectOption("reviewed");
  await page.getByRole("button", { name: /下一条待确认/ }).click();
  await expect(sentence).toContainText("已复核");
  await page.getByLabel("人工复核批注").fill("补充出处后再确认。");
  await expect(page.locator(".review-editor [role=status]")).toHaveText("已保存");
  await page.getByRole("button", { name: "清除批注", exact: true }).click();
  await page.getByRole("button", { name: "撤销批注", exact: true }).click();
  await expect(page.getByLabel("人工复核批注")).toHaveValue("补充出处后再确认。");
  await accessible(page);
  await fits(page);
  await page.locator(".analysis-sidebar.has-selection").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page
    .locator(".result")
    .screenshot({ path: test.info().outputPath("review-sidebar-desktop.png") });
  const result = await exported(page);
  expect(result.score).toBe(initial);
  expect(result.paragraphs[0].sentences[0].review.note).toContain("核对手稿");
  await tasks(page);
  await page.reload();
  await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toContainText("已复核");
});

test("mobile review drawer traps focus, saves on Escape and restores the original sentence focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await ready(page);
  await single(page);
  const sentence = page.locator("button.sent-button").first();
  await sentence.click();
  const dialog = page.getByRole("dialog", { name: "句子复核", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "收起句子说明" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(dialog.locator(".review-score-note summary")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByText("单句与相邻句上下文各检测一次，取两者较低分。请连同前后句阅读。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await accessible(page);
  await fits(page);
  await dialog.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: test.info().outputPath("review-drawer-mobile.png") });
  await page.getByLabel("人工复核批注").fill("手机上复核的记录。");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(sentence).toBeFocused();
  expect(await page.locator("#root").evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  expect((await exported(page)).paragraphs[0].sentences[0].review.note).toBe("手机上复核的记录。");
});

test("task center renames persistently and searches original filenames with combined filters", async ({
  page,
}) => {
  await ready(page);
  await single(page);
  await tasks(page);
  const row = page.locator(".task-item").first();
  await row.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("任务名称", { exact: true }).fill("第一稿 · 引用已经核对");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(row.getByRole("heading")).toHaveText("第一稿 · 引用已经核对");
  await page.reload();
  await tasks(page);
  await expect(page.getByRole("heading", { name: "第一稿 · 引用已经核对" })).toBeVisible();
  await page.getByLabel("搜索任务", { exact: true }).fill("original-PAPER");
  await expect(page.locator(".task-item")).toHaveCount(1);
  await page.getByLabel("任务类型", { exact: true }).selectOption("batch");
  await expect(page.getByText("没有匹配的任务", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByLabel("任务状态", { exact: true }).selectOption("complete");
  await expect(page.locator(".task-item")).toHaveCount(1);
  await accessible(page);
  await fits(page);
  await page.screenshot({
    path: test.info().outputPath("task-library-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await accessible(page);
  await fits(page);
  await page.screenshot({
    path: test.info().outputPath("task-library-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  await expect(page.locator(".result")).toBeVisible();
});

test("versions retain text changes, scores and reviews across refresh and restore without rescoring", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await single(page);
  const original = await exported(page);
  await page.locator("button.sent-button").first().click();
  await page.getByLabel("人工复核批注").fill("旧稿核对记录。");
  await page.getByRole("button", { name: "收起句子说明", exact: true }).click();
  let p = await panel(page);
  await p.getByLabel("版本名称", { exact: true }).fill("核对后的初稿");
  await p.getByRole("button", { name: "保存当前版本", exact: true }).click();
  const paragraph = page.locator("li.para").first();
  await paragraph.getByRole("button", { name: "在此修改并重测本段" }).click();
  const revised =
    "Furthermore, " +
    BODY.replaceAll("lake", "river") +
    "\n\n" +
    "A new paragraph records the date and the weather on our walk. ".repeat(3);
  await paragraph.getByLabel("修改第 1 段").fill(revised);
  await paragraph.getByRole("button", { name: "重测这一段", exact: true }).click();
  await expect(paragraph.getByRole("button", { name: "在此修改并重测本段" })).toBeVisible();
  p = await panel(page);
  await expect(p.locator("ins").first()).toBeVisible();
  await expect(p.locator("del").first()).toBeVisible();
  const changed = await exported(page);
  expect(changed.score).toBeGreaterThan(original.score);
  expect(changed.paragraphs).toHaveLength(2);
  expect(changed.writing_process.rechecks).toBe(1);
  expect(changed.writing_process.events.at(-1).kind).toBe("recheck");
  expect(
    changed.version_history.some((v: { result: unknown }) =>
      JSON.stringify(v.result).includes("旧稿核对记录"),
    ),
  ).toBe(true);
  await accessible(page);
  await fits(page);
  await p.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("version-comparison-desktop.png") });
  await tasks(page);
  await page.reload();
  await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  p = await panel(page);
  const restored = await exported(page);
  expect(restored.version_history.length).toBe(changed.version_history.length);
  let calls = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/detect")) calls++;
  });
  await p.getByLabel("右侧版本", { exact: true }).selectOption(changed.version_history[1].id);
  await p.getByRole("button", { name: "恢复右侧版本", exact: true }).click();
  const old = await exported(page);
  expect(old.score).toBe(original.score);
  expect(old.paragraphs[0].text).toBe(original.paragraphs[0].text);
  expect(old.paragraphs[0].sentences[0].review.note).toBe("旧稿核对记录。");
  expect(calls).toBe(0);
  expect(
    old.version_history.some((v: { result: unknown }) =>
      JSON.stringify(v.result).includes("river"),
    ),
  ).toBe(true);
  expect(old.writing_process.events.at(-1).kind).toBe("restore");
  expect(old.writing_process.events.some((e: { kind: string }) => e.kind === "recheck")).toBe(true);
  await page.setViewportSize({ width: 360, height: 900 });
  await fits(page);
  await accessible(page);
});

test("bilingual version comparison isolates language scores and restores the full saved document", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "中英混合演示", exact: true }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.getByText("检测结果 · 中文", { exact: true })).toBeVisible();
  await expect(page.locator(".scan-progress")).toHaveCount(0);
  const p = await panel(page);
  await p.getByLabel("版本名称", { exact: true }).fill("中英基线");
  await p.getByRole("button", { name: "保存当前版本", exact: true }).click();
  const english = await page
    .locator(".result")
    .first()
    .locator(".manuscript .body")
    .allTextContents();
  const chinese = page.locator(".result").last().locator("li.para").first();
  await chinese.getByRole("button", { name: "在此修改并重测本段" }).click();
  await chinese
    .getByLabel("修改第 1 段")
    .fill(
      "昨天我和弟弟走到河边，看到了几只鸭子。我们坐在岸边，讨论下周去山上散步的计划，也核对了地图上的路线。".repeat(
        4,
      ),
    );
  await chinese.getByRole("button", { name: "重测这一段", exact: true }).click();
  await expect(chinese.getByRole("button", { name: "在此修改并重测本段" })).toBeVisible();
  await expect(p.locator('.timeline-list li[data-kind="recheck"]')).toContainText("中文");
  await p.getByLabel("对比语言", { exact: true }).selectOption("en");
  expect(await p.locator("ins,del").count()).toBe(0);
  await p.getByLabel("对比语言", { exact: true }).selectOption("zh");
  await expect(p.locator("ins").first()).toBeVisible();
  expect(
    await page.locator(".result").first().locator(".manuscript .body").allTextContents(),
  ).toEqual(english);
  const options = await p
    .getByLabel("右侧版本", { exact: true })
    .locator("option")
    .allTextContents();
  const savedIndex = options.findIndex((text) => text.includes("中英基线"));
  await p.getByLabel("右侧版本", { exact: true }).selectOption({ index: savedIndex });
  await p.getByRole("button", { name: "恢复右侧版本", exact: true }).click();
  expect(
    await page.locator(".result").first().locator(".manuscript .body").allTextContents(),
  ).toEqual(english);
  await expect(chinese.locator(".body")).not.toContainText("昨天我和弟弟");
});

test("saved versions stay with their batch file when switching results and refreshing", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator('.input-panel input[type="file"]')
    .setInputFiles([file("first.txt"), file("second.txt")]);
  await page.getByRole("button", { name: "批量检测 2 个文件", exact: true }).click();
  await expect(page.getByText("共 2 个文件 · 完成 2 · 失败 0 · 已取消 0")).toBeVisible();
  await page.getByRole("button", { name: "查看 first.txt 的逐句结果", exact: true }).click();
  let p = await panel(page);
  await p.getByLabel("版本名称", { exact: true }).fill("第一份的版本");
  await p.getByRole("button", { name: "保存当前版本", exact: true }).click();
  await page.getByRole("button", { name: "查看 second.txt 的逐句结果", exact: true }).click();
  p = await panel(page);
  expect(
    await p.getByLabel("左侧版本", { exact: true }).locator("option").allTextContents(),
  ).not.toContainEqual(expect.stringContaining("第一份的版本"));
  await expect(p.locator(".timeline-list")).not.toContainText("第一份的版本");
  await tasks(page);
  await page.reload();
  await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  await page.getByRole("button", { name: "查看 first.txt 的逐句结果", exact: true }).click();
  p = await panel(page);
  expect(
    await p.getByLabel("左侧版本", { exact: true }).locator("option").allTextContents(),
  ).toContainEqual(expect.stringContaining("第一份的版本"));
  await expect(p.locator(".timeline-list")).toContainText("第一份的版本");
});

test("writing timeline preserves historical annotations, opens exact comparisons and survives reload on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await single(page, "Writing-process.txt");
  await page.locator("button.sent-button").first().click();
  await page.getByLabel("人工复核状态").selectOption("reviewed");
  await page.getByLabel("人工复核批注").fill("已经核对散步日期与手稿，请保留这一句。");
  await expect(page.locator(".review-editor [role=status]")).toHaveText("已保存");
  await page.getByRole("button", { name: "清除批注", exact: true }).click();
  await page.getByRole("button", { name: "收起句子说明", exact: true }).click();
  let p = await panel(page);
  await p.getByLabel("版本名称", { exact: true }).fill("核对完成 · 第一稿");
  await p.getByRole("button", { name: "保存当前版本", exact: true }).click();
  await p.getByLabel("时间线记录类型").selectOption("review");
  const historical = p
    .locator('.timeline-list li[data-kind="review"]')
    .filter({ hasText: "已复核" })
    .last();
  await historical.getByRole("button").click();
  await expect(p.getByRole("region", { name: "时间线记录详情" })).toContainText(
    "已经核对散步日期与手稿",
  );
  await expect(page.locator("button.sent-button").first()).not.toContainText("已复核");
  await p.getByLabel("时间线记录类型").selectOption("all");
  await p.locator('.timeline-list li[data-kind="manual"]').getByRole("button").click();
  await p.getByRole("button", { name: "查看这次修改" }).click();
  await expect(p.locator(".version-comparison-heading")).toBeFocused();
  const payload = await exported(page);
  await expect(p.getByLabel("左侧版本", { exact: true })).toHaveValue(
    payload.version_history[0].id,
  );
  await expect(p.getByLabel("右侧版本", { exact: true })).toHaveValue(
    payload.version_history[1].id,
  );
  await accessible(page);
  await fits(page);
  await p
    .locator('.timeline-list li[data-kind="review"]')
    .filter({ hasText: "已复核" })
    .last()
    .getByRole("button")
    .click();
  await p
    .locator(".writing-timeline")
    .screenshot({ path: test.info().outputPath("writing-timeline-desktop.png") });
  await tasks(page);
  await page.reload();
  await tasks(page);
  await page.getByRole("button", { name: "打开结果", exact: true }).click();
  p = await panel(page);
  const persisted = await exported(page);
  expect(persisted.writing_process).toEqual(payload.writing_process);
  await page.setViewportSize({ width: 360, height: 900 });
  await p.getByLabel("时间线记录类型").selectOption("review");
  await p
    .locator('.timeline-list li[data-kind="review"]')
    .filter({ hasText: "已复核" })
    .last()
    .getByRole("button")
    .click();
  await expect(p.getByRole("region", { name: "时间线记录详情" })).toContainText(
    "已经核对散步日期与手稿",
  );
  await accessible(page);
  await fits(page);
  await expect(p.getByRole("region", { name: "时间线记录详情" })).toBeFocused();
  await p
    .locator(".writing-timeline")
    .screenshot({ path: test.info().outputPath("writing-timeline-mobile.png") });
});
