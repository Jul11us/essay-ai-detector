import { expect, test, type Page } from "@playwright/test";

// 假模型：段落里有 "Furthermore" / "此外" 就给高分，否则低分（见 backend/e2e_server.py）。
const EN_FLAGGED =
  "Furthermore, the committee reviewed the proposal and noted that the schedule depends on several approvals from the city. The members agreed to meet again next month to discuss the remaining questions about the budget.";
const EN_PLAIN =
  "My brother and I walked to the lake after school. The water was cold, so we only put our feet in and watched the ducks. We talked about the trip we wanted to take next summer and who would bring the map.";
const EN_TEXT = `${EN_FLAGGED}\n\n${EN_PLAIN}`;

async function pickLanguage(page: Page, name: string) {
  await page.getByRole("button", { name }).first().click();
}

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
  await expect(page.getByText("中文可用")).toBeVisible();
}

test("example text goes from paste to sentence-level result", async ({ page }) => {
  await ready(page);
  await expect(page.getByRole("button", { name: "开始检测" })).toBeDisabled();

  await page.getByRole("button", { name: "英文演示" }).click();
  await page.getByRole("button", { name: "开始检测" }).click();

  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
  await expect(page.getByText("模型原始分数").first()).toBeVisible();
  // 逐句打分在分数之后另起请求，句子变成可点击的色块。
  await expect(page.locator("button.sent-button").first()).toBeVisible();
  await expect(page.getByText("全文分布 · 按模型档位")).toBeVisible();
});

test("flagged paragraph is marked high and can be rechecked after editing", async ({ page }) => {
  await ready(page);
  await pickLanguage(page, "英文");
  await page.getByLabel("粘贴正文").fill(EN_TEXT);
  await page.getByRole("button", { name: "开始检测" }).click();

  const paragraphs = page.locator("li.para");
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.nth(0)).toHaveClass(/high/);
  await expect(paragraphs.nth(1)).toHaveClass(/low/);

  await paragraphs.nth(0).getByRole("button", { name: "在此修改并重测本段" }).click();
  await paragraphs
    .nth(0)
    .getByLabel("修改第 1 段")
    .fill(EN_FLAGGED.replace("Furthermore, the", "The"));
  await paragraphs.nth(0).getByRole("button", { name: "重测这一段" }).click();

  await expect(paragraphs.nth(0)).toHaveClass(/low/);
});

test("too-short text is rejected with a readable message", async ({ page }) => {
  await ready(page);
  await pickLanguage(page, "英文");
  await page.getByLabel("粘贴正文").fill("Too short to score.");
  await page.getByRole("button", { name: "开始检测" }).click();

  await expect(page.getByRole("alert")).toContainText("文本太短");
  await expect(page.locator("section.result")).toHaveCount(0);
});

test("uploaded .txt is previewed before it is scored", async ({ page }) => {
  await ready(page);
  await pickLanguage(page, "英文");
  await page.locator('input[type="file"]').setInputFiles({
    name: "essay.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(EN_TEXT, "utf-8"),
  });

  await expect(page.getByLabel("文件提取文字预览")).toHaveValue(/committee reviewed the proposal/);
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
});

test("bilingual mode scores English and Chinese separately", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "中英混合演示" }).click();
  await page.getByRole("button", { name: "开始检测" }).click();

  await expect(page.getByRole("heading", { name: "英文部分" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "中文部分" })).toBeVisible();
  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
  await expect(page.getByText("检测结果 · 中文")).toBeVisible();
});
