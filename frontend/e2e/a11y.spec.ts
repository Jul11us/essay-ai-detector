import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// 只查 WCAG 2.x A/AA 的自动规则。自动检查抓不全（例如读屏顺序），但颜色对比、
// 缺标签、重复 id 这类问题能一次性兜住；界面靠颜色表达分数，这一点尤其重要。
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

async function violations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
});

test("input page has no detectable accessibility violations", async ({ page }) => {
  expect(await violations(page)).toEqual([]);
});

test("single result page has none", async ({ page }) => {
  await page.getByRole("button", { name: "英文演示" }).click();
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("bilingual result page has none", async ({ page }) => {
  await page.getByRole("button", { name: "中英混合演示" }).click();
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.getByText("检测结果 · 中文")).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("batch summary table has none", async ({ page }) => {
  await page.getByRole("button", { name: "英文" }).first().click();
  const text = "My brother and I walked to the lake after school. The water was cold, so we only put our feet in and watched the ducks. We talked about the trip we wanted to take next summer and who would bring the map.";
  await page.locator('input[type="file"]').setInputFiles([
    { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from(text) },
    { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from(text) },
  ]);
  await page.getByRole("button", { name: "批量检测 2 个文件" }).click();
  await expect(page.getByText("共 2 个文件，已处理 2 个")).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
