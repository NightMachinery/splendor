import { test, expect } from "@playwright/test";
import { mockGetUsername } from "./util/ls-mock.js";
import { mockGameState } from "./util/server-mock.js";
import { createBasicGame } from "./util/game.js";
import { withKnownLayoutDebt } from "./util/layout.js";
import { takeTokensThroughUi } from "./e2e/lib/ui-actor.js";

// The full-stack rendered game (tests/e2e/rendered-game.spec.ts) plays some
// turns through the board UI with these drivers. Here they run against the
// mocked board, so a selector change shows up without a running stack.

const nonZero = (m: Record<string, number>) => Object.fromEntries(Object.entries(m || {}).filter(([, v]) => v));

const open = async (page: import("@playwright/test").Page) => {
    const backend = await mockGameState(page, createBasicGame());
    await mockGetUsername(page, "linus");
    await page.goto("/gameboard/?sessionId=123");
    await expect(page.locator("body")).toHaveAttribute("data-splendor-ready", "1");
    return backend;
};

const move = (takeTokens: Record<string, number>, putBackTokens: Record<string, number> = {}) =>
    ({ action: "TAKE_TOKEN", body: { takeTokens, putBackTokens }, reason: "test" });

test("taking tokens through the modals sends exactly the bot's move", async ({ page, isMobile }, testInfo) => {
    const backend = await open(page);
    await withKnownLayoutDebt(testInfo, isMobile, "turn modal controls are covered by board chrome on phones", async () => {
        const played = await takeTokensThroughUi(page, "linus")({ move: move({ Red: 1, Blue: 1, Green: 1 }), player: "linus" });
        expect(played).toBe(true);
        await expect.poll(() => backend.actions.length).toBe(1);
    });
    const [sent] = backend.actions;
    expect(sent.action).toBe("TAKE_TOKEN");
    expect(nonZero((sent.body as any).takeTokens)).toEqual({ Red: 1, Blue: 1, Green: 1 });
    expect(nonZero((sent.body as any).putBackTokens)).toEqual({});
});

test("returned tokens and two of a colour go through the put-back modal", async ({ page }) => {
    const backend = await open(page);
    // force: dispatch the clicks, so this checks the request body on every viewport
    const played = await takeTokensThroughUi(page, "linus", { force: true })({ move: move({ Red: 2 }, { Gold: 1, Blue: 1 }), player: "linus" });
    expect(played).toBe(true);
    await expect.poll(() => backend.actions.length).toBe(1);
    const body = backend.actions[0].body as any;
    expect(nonZero(body.takeTokens)).toEqual({ Red: 2 });
    expect(nonZero(body.putBackTokens)).toEqual({ Gold: 1, Blue: 1 });
});

test("other moves and other seats are left to the API", async ({ page }) => {
    await open(page);
    const actor = takeTokensThroughUi(page, "linus");
    expect(await actor({ move: move({ Red: 1 }), player: "maex" })).toBe(false);
    expect(await actor({ move: { action: "BUY_CARD", body: { cardId: "01", tokens: {} }, reason: "" }, player: "linus" })).toBe(false);
    expect(await actor({ move: move({}), player: "linus" })).toBe(false);
});
