import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExportMenu } from "./ExportMenu";

function mount() {
  const { container } = render(
    <ExportMenu>
      <button type="button">导出 CSV</button>
    </ExportMenu>,
  );
  const menu = container.querySelector("details") as HTMLDetailsElement;
  return { menu, summary: menu.querySelector("summary") as HTMLElement };
}

// `toggle` 事件是异步派发的。键盘用户在慢的机器上按得比它快时，
// 菜单必须照样响应，不能等 React 状态和 effect 跟上。
describe("export menu closing", () => {
  it("closes on Escape pressed right after opening, before the toggle event arrives", () => {
    const { menu, summary } = mount();
    menu.open = true;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("closes on a pointer press outside right after opening", () => {
    const { menu } = mount();
    menu.open = true;
    fireEvent.pointerDown(document.body);
    expect(menu.open).toBe(false);
  });

  it("stays open for a press inside the menu and ignores other keys", () => {
    const { menu } = mount();
    menu.open = true;
    fireEvent.pointerDown(menu.querySelector("button") as HTMLElement);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(menu.open).toBe(true);
  });

  it("does nothing while the menu is closed", () => {
    const { menu, summary } = mount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(document.activeElement).not.toBe(summary);
  });
});
