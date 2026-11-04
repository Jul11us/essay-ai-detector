import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WordReportButton, requestWordReport } from "./WordReportButton";
import type { DetectOk } from "./types";
import { ensureProcess } from "./writingProcess";

const snapshot = { lang: "en", paragraphs: [{ text: "Current edited paragraph" }] } as DetectOk;
afterEach(() => vi.unstubAllGlobals());

it("posts the current edited snapshot and refuses a non-Word response", async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response("html error page", { headers: { "content-type": "text/html" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(requestWordReport(snapshot)).rejects.toThrow("没有返回 Word 文件");
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).result.paragraphs[0].text).toBe(
    "Current edited paragraph",
  );
});

it("shows a readable export failure and enables retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "报告内容不完整，请重新检测" }), { status: 400 }),
    ),
  );
  render(<WordReportButton data={snapshot} />);
  fireEvent.click(screen.getByRole("button", { name: "导出 Word 标注报告" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请重新检测");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "导出 Word 标注报告" })).toBeEnabled(),
  );
});

it("exports only the current document without including or mutating historical drafts", async () => {
  const data = {
    ...snapshot,
    version_history: [
      {
        id: "draft",
        label: "Old draft",
        created_at: "now",
        kind: "manual" as const,
        result: {
          ...snapshot,
          paragraphs: [{ ...snapshot.paragraphs[0], text: "Historical private draft" }],
        },
      },
    ],
  };
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response("document", {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
  );
  const recorded = ensureProcess(data);
  recorded.writing_process!.events[0].label = "Private historical timeline";
  vi.stubGlobal("fetch", fetchMock);
  await requestWordReport(recorded);
  const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  expect(body.result).not.toHaveProperty("version_history");
  expect(body.result).not.toHaveProperty("writing_process");
  expect(JSON.stringify(body)).not.toContain("Private historical timeline");
  expect(JSON.stringify(body)).not.toContain("Historical private draft");
  expect(data.version_history).toHaveLength(1);
});
