import { defineConfig, devices } from "@playwright/test";

/** The no-mocks end-to-end run against the local dev network; see global-setup.ts. */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./global-setup.ts",
  outputDir: "../test-results/real/playwright",
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4800/", trace: "retain-on-failure", actionTimeout: 30_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
