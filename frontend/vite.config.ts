import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 文档、CORS 白名单和 Playwright 都按 127.0.0.1 访问。不写的话 Vite 绑 localhost，
    // 在 localhost 先解析成 ::1 的机器（如 GitHub Actions 的 Ubuntu）上 127.0.0.1 连不上。
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
