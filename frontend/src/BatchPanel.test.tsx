import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchPanel } from "./BatchPanel";
import type { BatchRow } from "./batch";
import type { DetectOk } from "./types";
const OK = {
  score: 0.42,
  verdict: "uncertain",
  confidence: "medium",
  lang: "en",
  char_count: 900,
  paragraphs: [],
} as unknown as DetectOk;
const props = () => ({
  running: false,
  stopping: false,
  openIndex: null,
  onOpen: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onRetryFailed: vi.fn(),
  onLanguage: vi.fn(),
});
const rows: BatchRow[] = [
  { name: "low.txt", status: "done", lang: "en", result: { ...OK, score: 0.1 } },
  { name: "broken.pdf", status: "error", message: "file failed" },
  { name: "high.txt", status: "done", lang: "en", result: { ...OK, score: 0.9 } },
];
describe("BatchPanel", () => {
  it("keeps original indices when filtered and sorted", () => {
    const handlers = props();
    render(<BatchPanel {...handlers} rows={rows} />);
    fireEvent.change(screen.getByRole("combobox", { name: "批量结果筛选" }), {
      target: { value: "done" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "批量结果排序" }), {
      target: { value: "score-desc" },
    });
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("high.txt");
    expect(screen.queryByText("broken.pdf")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 high.txt 的逐句结果" }));
    expect(handlers.onOpen).toHaveBeenCalledWith(2, rows[2].result);
  });
  it("offers single-file and failed-file retries", () => {
    const handlers = props();
    render(<BatchPanel {...handlers} rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "重试 broken.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "重试失败文件（1）" }));
    expect(handlers.onRetry).toHaveBeenCalledWith(1);
    expect(handlers.onRetryFailed).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("combobox", { name: "检测 broken.pdf 的语言" }), {
      target: { value: "en" },
    });
    expect(handlers.onLanguage).toHaveBeenCalledWith(1, "en");
    expect(screen.queryByRole("combobox", { name: "检测 low.txt 的语言" })).not.toBeInTheDocument();
  });
  it("shows successful language scores separately with partial failures", () => {
    render(
      <BatchPanel
        {...props()}
        rows={[
          {
            name: "mixed.txt",
            status: "error",
            lang: "bi",
            message: "中文模型未就绪",
            result: {
              lang: "bi",
              note: "fixture",
              disclaimer: "fixture",
              en: OK,
              zh: { error: "not_ready", message: "中文模型未就绪" },
            },
          },
        ]}
      />,
    );
    expect(screen.getByRole("row", { name: /mixed.txt/ })).toHaveTextContent("部分完成");
    expect(screen.getByText("英文 42.0%")).toBeInTheDocument();
  });
});
