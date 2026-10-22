import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

const TEXT =
  "My brother and I walked to the lake after school. The water was cold, so we only put our feet in and watched the ducks. We talked about the trip we wanted to take next summer and who would bring the map.";
const record = (id: string, updates: Record<string, unknown> = {}) => ({
  id,
  lang: "en",
  label: "human",
  source: "Synthetic test fixture",
  source_url: "https://example.com/fixture",
  split: "test",
  group_id: id,
  score: 0.1,
  verdict: "low",
  confidence: "medium",
  char_count: 500,
  word_count: 80,
  model_id: "fixture-model",
  model_revision: "sha256:" + "a".repeat(64),
  ...updates,
});

test("evaluation report import, filters, exports and navigation retain detection results", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
  await page.getByRole("button", { name: "英文演示" }).click();
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
  await expect(page.getByRole("button", { name: "样本评测" })).toBeEnabled();
  await page.getByRole("button", { name: "样本评测" }).click();
  const records = [
    record("human"),
    record("ai", { label: "ai", score: 0.5, verdict: "uncertain" }),
    record("mixed", { lang: "zh", label: "mixed", score: 0.8, verdict: "high", char_count: 200 }),
  ];
  await page.getByLabel("导入评测报告", { exact: true }).setInputFiles({
    name: "report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ records })),
  });
  await expect(page.getByText("当前筛选 3 / 3 份 · 3 个问题／文章组")).toBeVisible();
  await expect(page.locator(".metric-overview")).toContainText("50.0%");
  await expect(page.locator(".metric-overview")).toContainText("1 / 2 份二元样本");
  const row = page
    .getByRole("table", { name: "误报、漏报和不确定比例" })
    .getByRole("row")
    .filter({ hasText: "AI 不确定" });
  await expect(row).toContainText("1 / 1 · 100.0%");
  await page.getByLabel("评测语言筛选").selectOption("zh");
  await expect(page.getByText("当前筛选 1 / 3 份 · 1 个问题／文章组")).toBeVisible();
  await expect(page.locator(".metric-overview dd").filter({ hasText: "无样本" })).toHaveCount(3);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出评测报告", exact: true }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.report.records).toHaveLength(3);
  await page.getByRole("button", { name: "作文检测", exact: true }).click();
  await expect(page.getByText("检测结果 · 英文")).toBeVisible();
  await page.getByRole("button", { name: "样本评测", exact: true }).click();
  await expect(page.getByText("当前筛选 1 / 3 份 · 1 个问题／文章组")).toBeVisible();
});

test("labelled local files run through the real API; failures stay visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
  await page.getByRole("button", { name: "样本评测", exact: true }).click();
  const samples = [
    {
      id: "human",
      file: "human.txt",
      lang: "en",
      label: "human",
      source: "Synthetic fixture",
      split: "descriptive",
    },
    {
      id: "ai",
      file: "ai.txt",
      lang: "en",
      label: "ai",
      source: "Synthetic fixture",
      split: "descriptive",
    },
    {
      id: "short",
      file: "short.txt",
      lang: "en",
      label: "human",
      source: "Synthetic fixture",
      split: "descriptive",
    },
  ];
  await page.getByLabel("导入样本清单", { exact: true }).setInputFiles({
    name: "manifest.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(samples.map((s) => JSON.stringify(s)).join("\n")),
  });
  await expect(page.getByText(/清单 3 份/)).toBeVisible();
  await page.getByLabel("选择评测样本文件", { exact: true }).setInputFiles([
    { name: "human.txt", mimeType: "text/plain", buffer: Buffer.from(`${TEXT}\n\n${TEXT}`) },
    {
      name: "ai.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`Furthermore, ${TEXT}\n\nFurthermore, ${TEXT}`),
    },
    { name: "short.txt", mimeType: "text/plain", buffer: Buffer.from("short") },
  ]);
  await page.getByRole("button", { name: "开始样本评测" }).click();
  await expect(page.getByText("已载入 2 份预测 · 1 个来源")).toBeVisible();
  await expect(page.getByText(/本轮计划 3 份，只完成 2 份/)).toBeVisible();
  await expect(page.getByText(/文本太短/)).toBeVisible();
  await expect(page.getByRole("button", { name: "导出候选阈值配置" })).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
});

test("Word downloads are genuine DOCX for single and bilingual current results", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("中文可用")).toBeVisible();
  await page.getByRole("button", { name: "中英混合演示" }).click();
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.getByText("检测结果 · 中文")).toBeVisible();
  for (const button of [
    page.getByRole("button", { name: "导出中英 Word 报告", exact: true }),
    page.getByRole("button", { name: "导出 Word 标注报告", exact: true }).first(),
  ]) {
    const downloadPromise = page.waitForEvent("download");
    await button.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.docx$/);
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("word/document.xml"))).toBe(true);
  }
});

test("stopping a sample run retains completed records and marks the round incomplete", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
  await page.getByRole("button", { name: "样本评测", exact: true }).click();
  const samples = ["a", "b", "c"].map((id) => ({
    id,
    file: `${id}.txt`,
    lang: "en",
    label: "human",
    source: "Synthetic fixture",
    split: "descriptive",
  }));
  await page.getByLabel("导入样本清单").setInputFiles({
    name: "manifest.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(samples)),
  });
  await expect(page.getByText(/清单 3 份/)).toBeVisible();
  await page.getByLabel("选择评测样本文件").setInputFiles(
    samples.map((s) => ({
      name: s.file,
      mimeType: "text/plain",
      buffer: Buffer.from(`${TEXT}\n\n${TEXT}`),
    })),
  );
  let requests = 0;
  await page.route("**/api/detect", async (route) => {
    requests++;
    if (requests !== 2) await route.continue();
    // Hold the second request so cancellation is deterministic.
  });
  await page.getByRole("button", { name: "开始样本评测" }).click();
  await expect(page.locator(".evaluation-run").getByText("完成", { exact: true })).toHaveCount(1);
  await expect(page.locator(".evaluation-run").getByText("检测中", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "停止本轮评测" }).click();
  await expect(page.getByText(/本轮计划 3 份，只完成 1 份/)).toBeVisible();
  await expect(page.locator(".evaluation-run").getByText("已取消", { exact: true })).toHaveCount(2);
  expect(requests).toBe(2);
  await expect(page.getByRole("button", { name: "继续未完成样本" })).toBeEnabled();
});
