import { useEffect, useRef, useState, type ReactNode } from "react";

// Native disclosure keeps every format reachable with a keyboard and avoids a custom menu focus trap.
export function ExportMenu({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current)
        menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <details
      ref={menu}
      className="export-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
