import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
}

async function fitsPage(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("keyboard upload opens a file preview and clearing it restores the pasted draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const draft = "A draft that stays here when I preview a document.";
  await page.getByRole("button", { name: "英文", exact: true }).click();
  await page.getByLabel("粘贴正文", { exact: true }).fill(draft);
  await expect(page.locator(".input-meta")).toContainText(`${draft.replace(/\s/g, "").length} 字符`);
  const upload = page.getByRole("button", { name: "上传文件", exact: true });
  await upload.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "keyboard-upload.txt", mimeType: "text/plain", buffer: Buffer.from("A different manuscript selected from a file.") });
  await expect(page.getByLabel("文件提取文字预览")).toHaveValue("A different manuscript selected from a file.");
  await expect(page.getByLabel("粘贴正文", { exact: true })).toHaveCount(0);
  await fitsPage(page);
  await page.getByRole("button", { name: "清除 keyboard-upload.txt", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("粘贴正文", { exact: true })).toHaveValue(draft);
  await expect(page.getByLabel("粘贴正文", { exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "英文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByText("上传说明", { exact: true }).click();
  await expect(page.getByText(/扫描版 PDF 读不出文字/)).toBeVisible();
  await fitsPage(page);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
});

for (const width of [360, 390, 768, 1440]) {
  test(`writing and evaluation workflows fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await fitsPage(page);
    await page.getByRole("button", { name: "中英混合演示" }).click();
    await page.getByRole("button", { name: "开始检测", exact: true }).click();
    await expect(page.getByText("检测结果 · 中文", { exact: true })).toBeVisible();
    await fitsPage(page);
    const firstMenu = page.locator(".export-menu summary").first();
    await firstMenu.click();
    await expect(page.getByRole("button", { name: "导出合并 CSV" })).toBeVisible();
    await fitsPage(page);
    await page.getByRole("button", { name: "样本评测", exact: true }).click();
    await expect(page.getByRole("heading", { name: "样本表现，逐项核对" })).toBeVisible();
    await fitsPage(page);
    await expect(page.getByLabel("导入评测报告")).toBeVisible();
    await page.getByRole("button", { name: "作文检测", exact: true }).click();
    await expect(page.getByText("检测结果 · 中文", { exact: true })).toBeVisible();
  });
}

test("keyboard opens and closes sentence details, then downloads through the disclosure", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到工作区" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-content")).toBeFocused();
  await page.getByRole("button", { name: "英文演示" }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  const sentence = page.locator("button.sent-button").first();
  await expect(sentence).toBeVisible();
  await expect(page.getByRole("region", { name: "检测结果", exact: true })).toBeFocused();
  await sentence.focus();
  await page.keyboard.press("Enter");
  await expect(sentence).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".sentence-detail")).toBeVisible();
  await page.getByRole("button", { name: "收起句子说明", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(sentence).toBeFocused();
  await expect(sentence).toHaveAttribute("aria-expanded", "false");
  const summary = page.locator(".export-menu summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  const csv = page.getByRole("button", { name: "导出 CSV", exact: true });
  await expect(csv).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(csv).not.toBeVisible();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await csv.focus();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toBe("ai-rate-result.csv");
  await expect(csv).not.toBeVisible();
});

test("reduced motion keeps mobile results and open controls accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  expect(await page.locator(".intro-copy").evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThan(.001);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  await page.getByRole("button", { name: "中文演示" }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  const sentence = page.locator("button.sent-button").first();
  await expect(sentence).toBeVisible();
  await sentence.click();
  await page.getByRole("button", {name:"收起句子说明",exact:true}).click();
  await page.locator(".export-menu summary").click();
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
  await fitsPage(page);
});
