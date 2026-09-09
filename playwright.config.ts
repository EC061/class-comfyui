import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 120000,
  use: { baseURL: "http://localhost:13000", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec tsx scripts/test-stack.ts",
    url: "http://localhost:13000/api/health",
    timeout: 60000,
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
