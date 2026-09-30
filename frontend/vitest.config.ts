import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    // e2e/ 下是 Playwright 的用例，不归 vitest 管。
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
