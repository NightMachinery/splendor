import os from "node:os";
import { defineConfig, devices, type Project } from "@playwright/test";
import { resolveStack } from "./tests/e2e/lib/stack.mjs";

// Two families of projects live side by side:
//
// - "mocked-*": the client against an Astro dev server, with the Lobby
//   Service and Game Service stubbed by page.route (tests/util/*). Needs no
//   backend. This is `pnpm test`.
// - "e2e-*": full-stack tests against a real, running stack (tests/e2e/**).
//   They skip themselves unless a stack is configured through E2E_INSTANCE
//   or E2E_BASE_URL / E2E_LS_URL / E2E_GS_URL (see tests/e2e/lib/stack.mjs).
//   "e2e-api" plays whole games over HTTP only and never opens a browser.
//
// See docs/testing.md for the full guide.

const stack = resolveStack();
const isCI = !!process.env.CI;

// Playwright 1.63 ships only a frozen WebKit build for macOS 14, and it dies
// with "Bus error: 10" on launch on macOS 14.3. So WebKit projects are off by
// default on macOS < 15 (Darwin < 24); PW_WEBKIT=1 forces them on, PW_WEBKIT=0
// forces them off anywhere. Linux CI runs them.
const darwinMajor = process.platform === "darwin" ? Number(os.release().split(".")[0]) : Infinity;
const withWebKit = process.env.PW_WEBKIT ? process.env.PW_WEBKIT === "1" : darwinMajor >= 24;

// Dedicated port so the mocked suite never reuses some other app that
// happens to listen on 3000, and never collides with ./self_host.py dev ports.
const mockPort = Number(process.env.PW_MOCK_PORT || 4329);
const mockBaseURL = `http://127.0.0.1:${mockPort}`;

// Only the mocked projects need the Astro dev server. Skip it when every
// selected project is a full-stack one, or when PW_SKIP_WEBSERVER=1.
const selectedProjects = process.argv
    .flatMap((arg, i, all) => (arg === "--project" ? [all[i + 1]] : arg.startsWith("--project=") ? [arg.slice(10)] : []))
    .filter(Boolean)
    .map((p) => p.replace(/^['"]|['"]$/g, ""));
const onlyFullStack = selectedProjects.length > 0 && selectedProjects.every((p) => p.startsWith("e2e"));
const needsWebServer = process.env.PW_SKIP_WEBSERVER !== "1" && !onlyFullStack;

const mocked = { testIgnore: /[\\/]e2e[\\/]/ };
const fullStack = {
    testMatch: /[\\/]e2e[\\/].*\.spec\.ts$/,
    testIgnore: /[\\/]e2e[\\/].*\.api\.spec\.ts$/,
};

const projects: Project[] = [
    // Mocked suite.
    { name: "mocked-desktop-chromium", ...mocked, use: { ...devices["Desktop Chrome"], baseURL: mockBaseURL } },
    { name: "mocked-mobile-chromium", ...mocked, use: { ...devices["Pixel 7"], baseURL: mockBaseURL } },
    // WebKit approximates iOS Safari rendering (Playwright's WebKit is not Safari itself).
    { name: "mocked-mobile-webkit", ...mocked, use: { ...devices["iPhone 14"], baseURL: mockBaseURL } },

    // Full-stack suite. Browserless whole games over the REST APIs.
    {
        name: "e2e-api",
        testMatch: /[\\/]e2e[\\/].*\.api\.spec\.ts$/,
        timeout: 10 * 60 * 1000,
        use: { baseURL: stack?.baseUrl ?? undefined },
    },
    // Rendered games: real stack, real board, one seat per viewport.
    {
        name: "e2e-desktop-chromium",
        ...fullStack,
        timeout: 10 * 60 * 1000,
        use: { ...devices["Desktop Chrome"], baseURL: stack?.baseUrl ?? undefined },
    },
    {
        name: "e2e-mobile-chromium",
        ...fullStack,
        timeout: 10 * 60 * 1000,
        use: { ...devices["Pixel 7"], baseURL: stack?.baseUrl ?? undefined },
    },
    {
        name: "e2e-mobile-webkit",
        ...fullStack,
        timeout: 10 * 60 * 1000,
        use: { ...devices["iPhone 14"], baseURL: stack?.baseUrl ?? undefined },
    },
];

export default defineConfig({
    testDir: "./tests",
    // Only *.spec.ts files are Playwright tests; tests/unit/*.test.mjs are node:test files.
    testMatch: /.*\.spec\.ts$/,
    timeout: 30 * 1000,
    expect: { timeout: 5000 },
    fullyParallel: true,
    forbidOnly: isCI,
    retries: isCI ? 1 : 0,
    workers: isCI ? 2 : undefined,
    reporter: [["list"], ["html", { open: "never" }]],
    outputDir: "test-results/",
    use: {
        actionTimeout: 10 * 1000,
        navigationTimeout: 20 * 1000,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: projects.filter((p) => withWebKit || !p.name?.endsWith("-webkit")),
    webServer: needsWebServer ? {
        command: `pnpm exec astro dev --host 127.0.0.1 --port ${mockPort}`,
        url: mockBaseURL,
        timeout: 120 * 1000,
        reuseExistingServer: !isCI,
        stdout: "ignore",
        stderr: "pipe",
    } : undefined,
});
