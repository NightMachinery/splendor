import { test, expect } from "@playwright/test";
import { mockGetUsername } from "./util/ls-mock.js";
import { mockGameState, createBasicGame } from "./util/server-mock.js";
import { md5 } from "./util/backend-mock.js";

test.describe.parallel("Test orient game", () => {
    test.beforeEach(async ({ page }) => {
        await mockGameState(page, createBasicGame());
        await mockGetUsername(page, "linus");
        await page.goto("/gameboard/?sessionId=123");
    });

    test("dev cards and nobles render with real images", async ({ page }) => {
        const nobleCount = createBasicGame().players.length + 1;

        await expect(page.locator("#board .board-nobles .noble-card img[src]")).toHaveCount(nobleCount);
        await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev:not(.board-card-dev-orient) img[src]")).toHaveCount(12);
        await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev.board-card-dev-orient img[src]")).toHaveCount(6);

        // The fixtures use real card ids, so every image must actually load.
        await expect.poll(() => page.locator("#board .board-cards-dev-selectable img[src], #board .board-nobles img[src]")
            .evaluateAll((imgs) => imgs.filter((img) => !(img as HTMLImageElement).complete || (img as HTMLImageElement).naturalWidth === 0)
                .map((img) => img.getAttribute("src"))))
            .toEqual([]);
    });

    test("the board long-polls with the MD5 of the last state body", async ({ page }) => {
        const backend = await mockGameState(page, createBasicGame());
        await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]")).toHaveCount(18);

        // After the first full answer, every poll must carry md5(body) so the
        // server can hold it (the 204 "no update" path), instead of the client
        // re-downloading the state in a tight loop.
        const body = JSON.stringify(createBasicGame());
        await expect.poll(() => backend.gameStateRequests().filter((r) => r.hash === md5(body)).length).toBeGreaterThan(0);
        const count = backend.gameStateRequests().length;
        await page.waitForTimeout(2500);
        // With a held poll (1.5 s in the mock) only a couple of requests fit in 2.5 s.
        expect(backend.gameStateRequests().length - count).toBeLessThanOrEqual(4);
    });
});
