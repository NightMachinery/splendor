import { test, expect, type Page } from "@playwright/test";
import { mockBackend, lobbySession } from "./util/backend-mock.js";
import { mockGetUsername } from "./util/ls-mock.js";
import { mockGameState } from "./util/server-mock.js";
import { createBasicGame, createCitiesGame, createTradingPostsGame } from "./util/game.js";
import {
    findHorizontalOverflow, findCoveredControls, withKnownLayoutDebt, formatOffenders, settle,
} from "./util/layout.js";

// Layout checks: nothing may stick out past the viewport edges, and controls
// in an open modal must not be covered by other elements.
//
type PageCase = {
    name: string;
    path: string;
    setup: (page: Page) => Promise<unknown>;
    ready: (page: Page) => Promise<void>;
    /** Selectors excluded from the overflow check on non-mobile viewports, with the reason in a comment. */
    desktopIgnore?: string[];
};

// Above 900px the opponents' inventories are a hover slide-out: a tab peeks in
// at the right edge and the rest waits off-screen by design.
const OPPONENT_DRAWER = ["#other-players .other-player-container"];

const boardReady = async (page: Page) => {
    await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]")).toHaveCount(18);
    await page.evaluate(() => document.fonts.ready);
};

const PAGES: PageCase[] = [
    {
        name: "title",
        path: "/",
        setup: (page) => mockGetUsername(page, "linus"),
        ready: async (page) => { await page.waitForLoadState("load"); await page.waitForTimeout(500); },
    },
    {
        name: "login",
        path: "/login/",
        setup: (page) => mockBackend(page),
        ready: async (page) => { await expect(page.locator("form")).toBeVisible(); },
    },
    {
        name: "lobby",
        path: "/lobby/",
        setup: async (page) => {
            const backend = await mockGetUsername(page, "linus", { displayName: "Linus Torvalds" });
            backend.setLobbyList({
                "1001": lobbySession({ creator: "linus", players: ["linus", "maex"], version: "BASE_ORIENT" }),
                "1002": lobbySession({ creator: "ada_lovelace", players: ["ada_lovelace"], version: "BASE_ORIENT_CITIES" }),
                "1003": lobbySession({ creator: "grace", players: ["grace", "linus", "alan"], version: "BASE_ORIENT_TRADE_ROUTES", launched: true }),
            });
        },
        ready: async (page) => { await expect(page.locator(".current-sessions-table tr[session-id]")).toHaveCount(3); },
    },
    {
        name: "board-orient",
        desktopIgnore: OPPONENT_DRAWER,
        path: "/gameboard/?sessionId=123",
        setup: async (page) => { await mockGameState(page, createBasicGame()); await mockGetUsername(page, "maex"); },
        ready: boardReady,
    },
    {
        name: "board-orient-your-turn",
        desktopIgnore: OPPONENT_DRAWER,
        path: "/gameboard/?sessionId=123",
        setup: async (page) => { await mockGameState(page, createBasicGame()); await mockGetUsername(page, "linus"); },
        ready: async (page) => { await boardReady(page); await expect(page.locator("#your-turn-modal")).toBeVisible(); },
    },
    {
        name: "board-cities",
        desktopIgnore: OPPONENT_DRAWER,
        path: "/gameboard-cities/?sessionId=123",
        setup: async (page) => { await mockGameState(page, createCitiesGame()); await mockGetUsername(page, "maex"); },
        ready: async (page) => { await boardReady(page); await expect(page.locator(".cities-container .city-card img[src]")).toHaveCount(3); },
    },
    {
        name: "board-tradingposts",
        desktopIgnore: OPPONENT_DRAWER,
        path: "/gameboard-tradingposts/?sessionId=123",
        setup: async (page) => { await mockGameState(page, createTradingPostsGame()); await mockGetUsername(page, "maex"); },
        ready: boardReady,
    },
];

// Playwright's WebKit cannot launch on the macOS 14 development machine, so
// the WebKit results have never been looked at. Until someone has, a WebKit
// failure is recorded as known debt rather than a red build.
const unverifiedEngine = (projectName: string) => projectName.includes("webkit");

const VIEWPORTS = [
    { label: "default", size: null },
    { label: "small", size: { width: 360, height: 740 } },
] as const;

for (const pc of PAGES) {
    for (const vp of VIEWPORTS) {
        test(`${pc.name} fits the viewport (${vp.label})`, async ({ page, isMobile }, testInfo) => {
            test.skip(vp.size !== null && !isMobile, "the small-phone variant runs on mobile projects only");
            const kind = vp.size ? "small" : isMobile ? "mobile" : "desktop";
            if (vp.size) await page.setViewportSize(vp.size);
            await pc.setup(page);
            await page.goto(pc.path);
            await pc.ready(page);
            await settle(page);

            const key = `${pc.name}@${kind}`;
            await withKnownLayoutDebt(testInfo, unverifiedEngine(testInfo.project.name), key, async () => {
                const width = await page.evaluate(() => window.innerWidth);
                if (isMobile) {
                    // Without <meta name="viewport"> a phone lays the page out
                    // ~980px wide and shrinks it, so nothing overflows yet
                    // everything is tiny. Catch that first.
                    expect(width, "layout viewport width (is <meta name=viewport> missing?)").toBe(page.viewportSize()!.width);
                }
                const offenders = await findHorizontalOverflow(page, { ignore: isMobile ? [] : pc.desktopIgnore ?? [] });
                await testInfo.attach("overflow.json", { body: JSON.stringify({ width, offenders }, null, 2), contentType: "application/json" });
                expect(offenders, `elements reaching past the ${width}px viewport:\n${formatOffenders(offenders)}`).toEqual([]);
            });
        });
    }
}

// Open each turn modal independently so the geometry probe can report its
// own controls even if a preceding dialog has a layout regression.
type ModalCase = { name: string; modal: string; steps: string[] };
const MODALS: ModalCase[] = [
    { name: "your-turn", modal: "#your-turn-modal", steps: [] },
    { name: "take-token", modal: "#take-token-modal", steps: ["#get-tokens-btn"] },
    { name: "put-back-token", modal: "#put-back-token-modal", steps: ["#get-tokens-btn", "#take-token-confirm-btn"] },
    { name: "buy-card", modal: "#buy-card-modal", steps: ["#purchase-btn"] },
    { name: "payment", modal: "#dev-card-payment-modal", steps: ["#purchase-btn", "#buy-card-modal .modal-board-cards .board-card-dev", "#buy-card-confirm-btn"] },
    { name: "reserve-card", modal: "#reserve-card-modal", steps: ["#reserve-btn"] },
];

for (const mc of MODALS) {
    for (const vp of VIEWPORTS) {
        test(`${mc.name} modal fits and its controls are reachable (${vp.label})`, async ({ page, isMobile }, testInfo) => {
            test.skip(vp.size !== null && !isMobile, "the small-phone variant runs on mobile projects only");
            const kind = vp.size ? "small" : isMobile ? "mobile" : "desktop";
            if (vp.size) await page.setViewportSize(vp.size);
            await mockGameState(page, createBasicGame());
            await mockGetUsername(page, "linus");
            await page.goto("/gameboard/?sessionId=123");
            await boardReady(page);
            await expect(page.locator("#your-turn-modal")).toBeVisible();
            for (const step of mc.steps) {
                await page.locator(step).first().dispatchEvent("click");
            }
            await expect(page.locator(mc.modal)).toBeVisible();
            await settle(page);

            const key = `modal-${mc.name}@${kind}`;
            await withKnownLayoutDebt(testInfo, unverifiedEngine(testInfo.project.name), key, async () => {
                const offenders = await findHorizontalOverflow(page, { ignore: isMobile ? [] : OPPONENT_DRAWER });
                const covered = await findCoveredControls(page, mc.modal);
                const width = await page.evaluate(() => window.innerWidth);
                await testInfo.attach("layout.json", { body: JSON.stringify({ width, offenders, covered }, null, 2), contentType: "application/json" });
                expect.soft(offenders, `elements reaching past the ${width}px viewport:\n${formatOffenders(offenders)}`).toEqual([]);
                expect.soft(covered, `controls in ${mc.modal} whose centre is covered by another element:\n${formatOffenders(covered)}`).toEqual([]);
                if (testInfo.errors.length) throw new Error(`${key}: layout problems (see above)`);
            });
        });
    }
}
