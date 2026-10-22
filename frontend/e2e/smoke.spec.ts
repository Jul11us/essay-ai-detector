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
  await expect(page.getByText("全文 AI 率")).toBeVisible();
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
  await expect(paragraphs.nth(0).getByLabel("修改第 1 段")).toBeFocused();
  await paragraphs
    .nth(0)
    .getByLabel("修改第 1 段")
    .fill(EN_FLAGGED.replace("Furthermore, the", "The"));
  await paragraphs.nth(0).getByRole("button", { name: "重测这一段" }).click();

  await expect(paragraphs.nth(0)).toHaveClass(/low/);
  await expect(paragraphs.nth(0).getByRole("button", { name: "在此修改并重测本段" })).toBeFocused();
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

  await page.getByText("更多导出", { exact: true }).click();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const csv = await streamToString(await (await csvDownload).createReadStream());
  expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM，Excel 才不会把中文显示成乱码
  expect(csv).toContain("language,paragraph,sentence,score");
  expect(csv).toContain("Furthermore");

  await page.getByText("更多导出", { exact: true }).click();
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
    {
      name: "flagged.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(EN_FLAGGED + " " + EN_PLAIN),
    },
    { name: "plain.txt", mimeType: "text/plain", buffer: Buffer.from(EN_PLAIN + " " + EN_PLAIN) },
    { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") },
  ]);
  await expect(page.getByText("批量检测 · 3 个文件")).toBeVisible();
  await page.getByRole("button", { name: "批量检测 3 个文件" }).click();

  const table = page.getByRole("table");
  await expect(page.getByText("共 3 个文件 · 完成 2 · 失败 1 · 已取消 0")).toBeVisible();
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
  await page.getByRole("button", { name: "导出全部汇总 CSV" }).click();
  const csv = await streamToString(await (await download).createReadStream());
  expect(csv).toContain("flagged.txt,done,en");
  expect(csv).toContain("broken.pdf,error");
});

test("batch retains paragraph rechecks when switching files and exporting the summary", async ({
  page,
}) => {
  await ready(page);
  await pickLanguage(page, "英文");
  const flaggedText = `${EN_FLAGGED} ${EN_PLAIN}`;
  const editedText = flaggedText.replace("Furthermore, the", "The");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "flagged.txt", mimeType: "text/plain", buffer: Buffer.from(flaggedText) },
    { name: "plain.txt", mimeType: "text/plain", buffer: Buffer.from(`${EN_PLAIN} ${EN_PLAIN}`) },
  ]);
  await page.getByRole("button", { name: "批量检测 2 个文件" }).click();
  await expect(page.getByText("共 2 个文件 · 完成 2 · 失败 0 · 已取消 0")).toBeVisible();

  await page.getByRole("button", { name: "查看 flagged.txt 的逐句结果" }).click();
  const paragraph = page.locator("li.para").first();
  await expect(paragraph).toHaveClass(/high/);
  await paragraph.getByRole("button", { name: "在此修改并重测本段" }).click();
  await paragraph.getByLabel("修改第 1 段").fill(editedText);
  await paragraph.getByRole("button", { name: "重测这一段" }).click();
  await expect(paragraph).toHaveClass(/low/);

  await page.getByRole("button", { name: "查看 plain.txt 的逐句结果" }).click();
  await page.getByRole("button", { name: "查看 flagged.txt 的逐句结果" }).click();
  await expect(paragraph).toHaveClass(/low/);
  await expect(paragraph.locator("p.body")).toHaveText(editedText);
  await expect(page.getByRole("table").getByRole("row", { name: /flagged\.txt/ })).toContainText(
    "8.0%",
  );

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部汇总 CSV" }).click();
  const csv = await streamToString(await (await download).createReadStream());
  expect(csv).toContain("flagged.txt,done,en,0.08,low");
});

test("batch automatically identifies English, Chinese and mixed files without a language choice", async ({
  page,
}) => {
  await ready(page);
  const chinese =
    "上周末我和朋友在校园里散步，路过图书馆时看见门口摆着几箱旧书。我们停下来挑了两本小说，后来坐在湖边讨论了故事里的主人公。天气忽然变冷，我们把外套穿上，沿着小路走回宿舍。那天没有特别的计划，但一路上的聊天让我记得很清楚。".repeat(
      3,
    );
  await page.locator('input[type="file"]').setInputFiles([
    { name: "english.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
    { name: "chinese.txt", mimeType: "text/plain", buffer: Buffer.from(chinese) },
    { name: "mixed.txt", mimeType: "text/plain", buffer: Buffer.from(`${EN_TEXT}\n\n${chinese}`) },
  ]);
  await page.getByRole("button", { name: "批量检测 3 个文件" }).click();
  await expect(page.getByText("共 3 个文件 · 完成 3 · 失败 0 · 已取消 0")).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByRole("row", { name: /english.txt/ })).toContainText("英文");
  await expect(table.getByRole("row", { name: /chinese.txt/ })).toContainText("中文");
  await expect(table.getByRole("row", { name: /mixed.txt/ })).toContainText("中英分开");
  await page.getByRole("button", { name: "查看 mixed.txt 的逐句结果" }).click();
  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
  await expect(page.getByText("检测结果 · 中文")).toBeVisible();
  const englishParagraph = page.locator("li.para").first();
  const editedEnglish = EN_FLAGGED.replace("Furthermore, the", "The");
  await englishParagraph.getByRole("button", { name: "在此修改并重测本段" }).click();
  await englishParagraph.getByLabel("修改第 1 段").fill(editedEnglish);
  await englishParagraph.getByRole("button", { name: "重测这一段" }).click();
  await expect(englishParagraph).toHaveClass(/low/);
  await page.getByRole("button", { name: "查看 english.txt 的逐句结果" }).click();
  await page.getByRole("button", { name: "查看 mixed.txt 的逐句结果" }).click();
  await expect(englishParagraph.locator("p.body")).toHaveText(editedEnglish);
  await page.getByRole("combobox", { name: "批量结果排序" }).selectOption("name");
  await expect(table.getByRole("row").nth(1)).toContainText("chinese.txt");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部汇总 CSV" }).click();
  const csv = await streamToString(await (await download).createReadStream());
  expect(csv).toContain("mixed.txt,done,en");
  expect(csv).toContain("mixed.txt,done,zh");
});

test("batch cancellation keeps the active result and continues only remaining files", async ({
  page,
}) => {
  await ready(page);
  let calls = 0;
  let finish!: () => void;
  await page.route("**/api/detect", async (route) => {
    calls++;
    if (calls === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles(
    ["a.txt", "b.txt", "c.txt"].map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(EN_TEXT),
    })),
  );
  await page.getByRole("button", { name: "批量检测 3 个文件" }).click();
  await expect.poll(() => calls).toBe(1);
  await page.getByRole("button", { name: "取消后续文件" }).click();
  await expect(
    page.getByText("当前文件会继续完成；尚未开始的文件将取消，完成结果会保留。"),
  ).toBeVisible();
  finish();
  await expect(page.getByText("共 3 个文件 · 完成 1 · 失败 0 · 已取消 2")).toBeVisible();
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "继续检测 2 个未完成文件" }).click();
  await expect(page.getByText("共 3 个文件 · 完成 3 · 失败 0 · 已取消 0")).toBeVisible();
  expect(calls).toBe(3);
});

test("single-file retry and filters preserve other completed results", async ({ page }) => {
  await ready(page);
  let previewFailures = 0;
  await page.route("**/api/preview", async (route) => {
    if (route.request().postData()?.includes('filename="retry.txt"') && previewFailures++ === 0) {
      await route.fulfill({ json: { error: "temporary", message: "临时提取失败" } });
    } else await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles([
    { name: "good.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
    { name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
  ]);
  await page.getByRole("button", { name: "批量检测 2 个文件" }).click();
  await expect(page.getByText("共 2 个文件 · 完成 1 · 失败 1 · 已取消 0")).toBeVisible();
  await page.getByRole("combobox", { name: "批量结果筛选" }).selectOption("error");
  await expect(page.getByRole("table").getByRole("row", { name: /good.txt/ })).toHaveCount(0);
  await page.getByRole("button", { name: "重试 retry.txt" }).click();
  await expect(page.getByText("共 2 个文件 · 完成 2 · 失败 0 · 已取消 0")).toBeVisible();
  await page.getByRole("combobox", { name: "批量结果筛选" }).selectOption("all");
  await expect(page.getByRole("table").getByRole("row", { name: /good.txt/ })).toContainText(
    "完成",
  );
  await expect(page.getByRole("table").getByRole("row", { name: /retry.txt/ })).toContainText(
    "完成",
  );
});

test("over-limit selection is explicitly rejected without truncating", async ({ page }) => {
  await ready(page);
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 21 }, (_, i) => ({
      name: `file-${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(EN_TEXT),
    })),
  );
  await expect(page.getByRole("alert")).toContainText("你选择了 21 个文件，每批最多 20 个");
  await expect(page.getByRole("alert")).toContainText("本次选择未添加");
  await expect(page.getByText("批量检测 · 20 个文件")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始检测" })).toBeDisabled();
});

test("an unrecognised file can be retried with a manual language while finished files stay intact", async ({
  page,
}) => {
  await ready(page);
  let detects = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/detect")) detects++;
  });
  await page.route("**/api/preview", async (route) => {
    const response = await route.fetch();
    if (route.request().postData()?.includes('filename="unknown.txt"')) {
      await route.fulfill({ response, json: { ...(await response.json()), language_hint: null } });
    } else await route.fulfill({ response });
  });
  await page.locator('input[type="file"]').setInputFiles([
    { name: "done.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
    { name: "unknown.txt", mimeType: "text/plain", buffer: Buffer.from(EN_TEXT) },
  ]);
  await page.getByRole("button", { name: "批量检测 2 个文件" }).click();
  await expect(page.getByText("共 2 个文件 · 完成 1 · 失败 1 · 已取消 0")).toBeVisible();
  await expect(page.getByRole("table")).toContainText("无法自动识别语言");
  await expect(page.getByRole("combobox", { name: "检测 done.txt 的语言" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "检测 unknown.txt 的语言" }).selectOption("en");
  await page.getByRole("button", { name: "重试 unknown.txt" }).click();
  await expect(page.getByText("共 2 个文件 · 完成 2 · 失败 0 · 已取消 0")).toBeVisible();
  expect(detects).toBe(2);
});

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream ?? []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
