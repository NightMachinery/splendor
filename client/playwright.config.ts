import { defineConfig, devices } from "@playwright/test";

const runFullStack = process.env.E2E_FULL_STACK === "1";
const fullStackBaseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests",
  timeout: runFullStack ? 90 * 1000 : 30 * 1000,
  expect: {
    timeout: 5000
  },
  fullyParallel: !runFullStack,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: runFullStack ? 1 : (process.env.CI ? 1 : undefined),
  reporter: "html",
  use: {
    actionTimeout: 0,
    baseURL: runFullStack ? fullStackBaseUrl : "http://localhost:3000",
    launchOptions: {
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
    },
    trace: "on-first-retry",
  },
  projects: runFullStack ? [
    {
      name: "full-stack-chromium",
      testMatch: /.*\/e2e\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "full-stack-mobile",
      testMatch: /.*\/e2e\/.*\.spec\.ts/,
      use: { ...devices["Pixel 5"], channel: "chrome" },
    },
  ] : [
    {
      name: "chromium",
      testIgnore: /.*\/e2e\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "firefox",
      testIgnore: /.*\/e2e\/.*\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
  ],
  outputDir: "test-results/",
  webServer: runFullStack ? undefined : {
    command: "npm run dev",
    url: "http://localhost:3000",
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI,
  },
});
