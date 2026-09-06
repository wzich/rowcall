import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "browser.test.ts",
  outputDir: "../output/playwright",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
