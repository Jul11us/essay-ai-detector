import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewEditor } from "./ReviewEditor";

afterEach(() => vi.useRealTimers());
describe("review autosave", () => {
  it("debounces typing, keeps state and note together, and uses the latest callback", () => {
    vi.useFakeTimers();
    const first = vi.fn(),
      latest = vi.fn();
    const { rerender } = render(<ReviewEditor onSave={first} />);
    fireEvent.change(screen.getByLabelText("人工复核批注"), {
      target: { value: "Check the draft." },
    });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.change(screen.getByLabelText("人工复核状态"), { target: { value: "reviewed" } });
    rerender(<ReviewEditor onSave={latest} />);
    act(() => vi.advanceTimersByTime(500));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest.mock.calls[0][0]).toMatchObject({ state: "reviewed", note: "Check the draft." });
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });
  it("flushes an unfinished note once when moving to another sentence", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const { unmount } = render(<ReviewEditor onSave={save} />);
    fireEvent.change(screen.getByLabelText("人工复核批注"), {
      target: { value: "Don't lose this." },
    });
    unmount();
    act(() => vi.runAllTimers());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].note).toBe("Don't lose this.");
  });
  it("undoes clearing a saved review and restores the original state", () => {
    const save = vi.fn();
    const review = {
      state: "reviewed" as const,
      note: "Preserve original review",
      updated_at: "now",
    };
    render(<ReviewEditor review={review} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "清除批注" }));
    expect(save).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "撤销批注" }));
    expect(save).toHaveBeenLastCalledWith(review);
    expect(screen.getByLabelText("人工复核批注")).toHaveValue(review.note);
  });
  it("does not create an empty review just by opening or closing the pane", () => {
    const save = vi.fn();
    const { unmount } = render(<ReviewEditor onSave={save} />);
    unmount();
    expect(save).not.toHaveBeenCalled();
  });
});
