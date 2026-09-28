import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest 没开 globals，React Testing Library 的自动 cleanup 不会注册，
// 不显式清理的话每个测试的 <App /> 都会留在 DOM 里，查询就撞上重复元素。
afterEach(() => {
  cleanup();
});
