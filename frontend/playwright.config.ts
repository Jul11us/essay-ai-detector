import { defineConfig } from "@playwright/test";

// 端到端冒烟测试：真实的 Vite 前端 + 真实的 FastAPI 接口 + 假打分模型（backend/e2e_server.py）。
// 不需要模型权重。`E2E_PYTHON` 指定装好后端依赖的解释器；
// `PW_CHROMIUM_PATH` 指定本机已有的 Chromium（没设就用 Playwright 自己下载的那个）。
const python = process.env.E2E_PYTHON ?? "python3";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
  },
  webServer: [
    {
      command: `${python} e2e_server.py`,
      cwd: "../backend",
      url: "http://127.0.0.1:8000/api/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
