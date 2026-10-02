import os from "node:os";
import { defineConfig, devices, type PlaywrightTestConfig, type Project } from "@playwright/test";
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
// E2E_FAKE_STACK=1 (pnpm run test:e2e:fake) runs the full-stack projects
// offline: Playwright builds the client (astro build, into
// node_modules/.cache/e2e-fake-dist) and starts tests/fixtures/fake-stack.mjs,
// which serves that build with /ls and /gs routed to fake Lobby and Game
// Services over the rules mirror in tests/fixtures/engine.mjs, and points
// E2E_* at it. It checks the client, the bot and the specs, not the real
// server. A static build, not `astro dev`: a dev server restarts or reloads
// the page when files under client/ change, which breaks a game mid-run.
// E2E_FAKE_SKIP_BUILD=1 reuses the last build.
//
// See docs/testing.md for the full guide.

const isCI = !!process.env.CI;
const fakeStack = process.env.E2E_FAKE_STACK === "1";
const fakePorts = {
    web: Number(process.env.E2E_FAKE_WEB_PORT || 4330),
    ls: Number(process.env.E2E_FAKE_LS_PORT || 4331),
    gs: Number(process.env.E2E_FAKE_GS_PORT || 4332),
};
if (fakeStack) {
    const fakeUrls = {
        E2E_BASE_URL: `http://127.0.0.1:${fakePorts.web}`,
        E2E_LS_URL: `http://127.0.0.1:${fakePorts.ls}`,
        E2E_GS_URL: `http://127.0.0.1:${fakePorts.gs}`,
    };
    // The workers inherit what the runner sets here and load this config again.
    const clash = Object.entries(fakeUrls).some(([k, v]) => process.env[k] && process.env[k] !== v);
    if (process.env.E2E_INSTANCE || clash) {
        throw new Error("E2E_FAKE_STACK=1 starts its own stack: unset E2E_INSTANCE and E2E_BASE_URL / E2E_LS_URL / E2E_GS_URL");
    }
    Object.assign(process.env, fakeUrls);
}
const stack = resolveStack();

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
const onlyApi = selectedProjects.length > 0 && selectedProjects.every((p) => p === "e2e-api");
const skipWebServers = process.env.PW_SKIP_WEBSERVER === "1";
const needsWebServer = !skipWebServers && !onlyFullStack;

type WebServer = Exclude<NonNullable<PlaywrightTestConfig["webServer"]>, readonly unknown[]>;
const webServers: WebServer[] = [];
if (needsWebServer) {
    webServers.push({
        command: `pnpm exec astro dev --host 127.0.0.1 --port ${mockPort}`,
        url: mockBaseURL,
        timeout: 120 * 1000,
        reuseExistingServer: !isCI,
        stdout: "ignore",
        stderr: "pipe",
    });
}
if (fakeStack && !skipWebServers) {
    const fakeDist = "node_modules/.cache/e2e-fake-dist";
    const serve = `node tests/fixtures/fake-stack.mjs --ls-port ${fakePorts.ls} --gs-port ${fakePorts.gs} --seed ${Number(process.env.E2E_SEED || 1)}`;
    const build = process.env.E2E_FAKE_SKIP_BUILD === "1" ? "" : "pnpm exec astro build && ";
    webServers.push({
        // the API project needs no client
        command: onlyApi ? serve : `${build}${serve} --web-port ${fakePorts.web} --dist ${fakeDist}`,
        url: onlyApi ? `http://127.0.0.1:${fakePorts.ls}/api/online` : `http://127.0.0.1:${fakePorts.web}/gs/api/online`,
        timeout: 180 * 1000,
        // a stale stack from another run would hold other users and sessions; refuse it
        reuseExistingServer: false,
        env: { SPLENDOR_DIST_DIR: fakeDist },
        stdout: "ignore",
        stderr: "pipe",
    });
}

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
    // Rendered games: real stack, real board. One project per browser
    // engine; each test opens its own two seats (a 1280x800 desktop and an
    // emulated phone with touch, see rendered-game.spec.ts), so the
    // project's `use` only picks the engine.
    {
        name: "e2e-ui-chromium",
        ...fullStack,
        timeout: 10 * 60 * 1000,
        use: { ...devices["Desktop Chrome"], baseURL: stack?.baseUrl ?? undefined },
    },
    {
        name: "e2e-ui-webkit",
        ...fullStack,
        timeout: 10 * 60 * 1000,
        use: { ...devices["Desktop Safari"], baseURL: stack?.baseUrl ?? undefined },
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
    webServer: webServers.length ? webServers : undefined,
});
