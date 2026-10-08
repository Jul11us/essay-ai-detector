import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
}

async function runExample(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();
}

async function openTasks(page: Page) {
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByText("已保存到本机", { exact: true })).toBeVisible();
}

/** 直接数浏览器里 IndexedDB 的记录，确认清掉的不只是界面。 */
async function stored(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ tasks: number; files: number }>((resolve, reject) => {
        const open = indexedDB.open("writing-lens-tasks");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["tasks", "files"]);
          const tasks = tx.objectStore("tasks").count();
          const files = tx.objectStore("files").count();
          tx.oncomplete = () => {
            db.close();
            resolve({ tasks: tasks.result, files: files.result });
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

test("clear-all removes every saved task from the page and from IndexedDB, and stays gone after a reload", async ({ page }) => {
  await ready(page);
  await runExample(page, "英文演示");
  await page.getByRole("button", { name: "中文演示", exact: true }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.locator("button.sent-button").first()).toBeVisible();

  await openTasks(page);
  await expect(page.getByText(/^\d+ \/ 2 个任务$/)).toBeVisible();
  expect((await stored(page)).tasks).toBe(2);

  await page.getByRole("button", { name: "清空全部本机任务", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("清空全部 2 个任务");
  // 先“保留”：什么都不该被删。
  await page.getByRole("button", { name: "保留任务", exact: true }).click();
  expect((await stored(page)).tasks).toBe(2);

  await page.getByRole("button", { name: "清空全部本机任务", exact: true }).click();
  await page.getByRole("button", { name: "确认清空", exact: true }).click();
  await expect(page.getByText("等待你的第一份任务")).toBeVisible();
  await expect(page.getByRole("button", { name: "清空全部本机任务", exact: true })).toHaveCount(0);
  expect(await stored(page)).toEqual({ tasks: 0, files: 0 });

  await page.reload();
  await expect(page.getByText("英文可用")).toBeVisible();
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByText("等待你的第一份任务")).toBeVisible();
});

test("a new task after clear-all is saved normally", async ({ page }) => {
  await ready(page);
  await runExample(page, "英文演示");
  await openTasks(page);
  await page.getByRole("button", { name: "清空全部本机任务", exact: true }).click();
  await page.getByRole("button", { name: "确认清空", exact: true }).click();
  await expect(page.getByText("等待你的第一份任务")).toBeVisible();

  await page.goto("/");
  await expect(page.getByText("英文可用")).toBeVisible();
  await runExample(page, "英文演示");
  await openTasks(page);
  expect((await stored(page)).tasks).toBe(1);
});

test("the task center with the clear-all confirmation open has no axe violations", async ({ page }) => {
  await ready(page);
  await runExample(page, "英文演示");
  await openTasks(page);
  await page.getByRole("button", { name: "清空全部本机任务", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 2).map((n) => n.target.join(" ")) }))).toEqual([]);
});
