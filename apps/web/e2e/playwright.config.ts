import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./global-setup.ts",
  outputDir: "../test-results/playwright",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4791/", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
