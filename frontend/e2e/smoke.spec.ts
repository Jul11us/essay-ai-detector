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

test("result can be exported as JSON and CSV", async ({ page }) => {
  await ready(page);
  await pickLanguage(page, "英文");
  await page.getByLabel("粘贴正文").fill(EN_TEXT);
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();

  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const csv = await streamToString(await (await csvDownload).createReadStream());
  expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM，Excel 才不会把中文显示成乱码
  expect(csv).toContain("language,paragraph,sentence,score");
  expect(csv).toContain("Furthermore");

  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  const json = JSON.parse(await streamToString(await (await jsonDownload).createReadStream()));
  expect(json.schema).toBe(1);
  expect(json.result.paragraphs).toHaveLength(2);
});

test("several files are scored one by one and each can be opened", async ({ page }) => {
  await ready(page);
  await pickLanguage(page, "英文");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "flagged.txt", mimeType: "text/plain", buffer: Buffer.from(EN_FLAGGED + " " + EN_PLAIN) },
    { name: "plain.txt", mimeType: "text/plain", buffer: Buffer.from(EN_PLAIN + " " + EN_PLAIN) },
    { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") },
  ]);
  await expect(page.getByText("批量检测 · 3 个文件")).toBeVisible();
  await page.getByRole("button", { name: "批量检测 3 个文件" }).click();

  const table = page.getByRole("table");
  await expect(page.getByText("共 3 个文件，已处理 3 个")).toBeVisible();
  const flagged = table.getByRole("row", { name: /flagged\.txt/ });
  const plain = table.getByRole("row", { name: /plain\.txt/ });
  // 假模型：带 Furthermore 的 95%，否则 8%。短文本置信度低，所以 95% 也只标“不确定”。
  await expect(flagged).toContainText("95.0%");
  await expect(plain).toContainText("8.0%");
  await expect(plain).toContainText("较低");
  // 一个文件失败不影响其他文件。
  await expect(table.getByRole("row", { name: /broken\.pdf/ })).toContainText("失败");

  await page.getByRole("button", { name: "查看 flagged.txt 的逐句结果" }).click();
  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
  await expect(page.locator("button.sent-button").first()).toBeVisible();
  await expect(flagged).toHaveAttribute("aria-current", "true");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出汇总 CSV" }).click();
  const csv = await streamToString(await (await download).createReadStream());
  expect(csv).toContain("flagged.txt,done,en");
  expect(csv).toContain("broken.pdf,error");
});

test("batch is not offered for the bilingual mode", async ({ page }) => {
  await ready(page);
  await pickLanguage(page, "中英分开");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
    { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
  ]);
  await expect(page.getByText("批量检测不支持“中英分开”")).toBeVisible();
  await expect(page.getByRole("button", { name: /批量检测 2 个文件/ })).toBeDisabled();
});

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream ?? []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
