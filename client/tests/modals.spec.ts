import { test, expect } from "@playwright/test";
import { mockGetUsername } from "./util/ls-mock.js";
import { mockGameState, createBasicGame } from "./util/server-mock.js";

test.describe.parallel("Test default game modals", () => {
    test("the your-turn modal appears for the player to move", async ({ page }) => {
        await mockGameState(page, createBasicGame());
        await mockGetUsername(page, "linus");
        await page.goto("/gameboard/?sessionId=123");

        await expect(page.locator("#your-turn-modal")).toBeVisible();
    });

    test("the your-turn modal stays hidden for the waiting player", async ({ page }) => {
        await mockGameState(page, createBasicGame());
        await mockGetUsername(page, "maex"); // seat 1; turnCounter is 0
        await page.goto("/gameboard/?sessionId=123");

        // Wait until the state has actually rendered, so the check below is not vacuous.
        await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]")).toHaveCount(18);
        await expect(page.locator("#player-inventory")).toBeVisible();
        await expect(page.locator("#your-turn-modal")).toBeHidden();
    });

    test("a spectator sees the board but no inventory and no turn modal", async ({ page }) => {
        await mockGameState(page, createBasicGame());
        await mockGetUsername(page, "user3");
        await page.goto("/gameboard/?sessionId=123");

        await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]")).toHaveCount(18);
        await expect(page.locator("#player-inventory")).toBeHidden();
        await expect(page.locator("#your-turn-modal")).toBeHidden();
    });

    test("the turn modal moves to the next player when the state changes", async ({ page }) => {
        const game = createBasicGame();
        await mockGameState(page, game);
        await mockGetUsername(page, "maex");
        await page.goto("/gameboard/?sessionId=123");
        await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]")).toHaveCount(18);
        await expect(page.locator("#your-turn-modal")).toBeHidden();

        // A live update (no reload): it is now maex's turn.
        await mockGameState(page, game.setTurnCounter(1));
        await expect(page.locator("#your-turn-modal")).toBeVisible();
    });

    test("the game-over modal names the winner", async ({ page }) => {
        const game = createBasicGame();
        game.getPlayer("maex").prestigePoints = 16;
        await mockGameState(page, game.finish("maex"));
        await mockGetUsername(page, "linus");
        await page.goto("/gameboard/?sessionId=123");

        const modal = page.locator("#gameover-modal");
        await expect(modal).toBeVisible();
        await expect(modal).toContainText(/maex/i);
        await expect(page.locator("#your-turn-modal")).toBeHidden();
    });
});
