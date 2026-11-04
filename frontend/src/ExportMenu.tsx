import { useEffect, useRef, type ReactNode } from "react";

// Native disclosure keeps every format reachable with a keyboard and avoids a custom menu focus trap.
export function ExportMenu({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  // The listeners are attached once and read the live `open` state of the element. They used to be
  // attached from an effect that only ran after the asynchronous `toggle` event and a React
  // re-render, so Escape or an outside press right after opening was silently dropped.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const details = menu.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target))
        details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const details = menu.current;
      if (event.key === "Escape" && details?.open) {
        details.open = false;
        details.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details ref={menu} className="export-menu">
      <summary>
        <span>更多导出</span> <span aria-hidden="true">⌄</span>
      </summary>
      <div
        className="export-options"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button") && menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}
      >
        {children}
        <p>下载位置由浏览器设置决定</p>
      </div>
    </details>
  );
}
