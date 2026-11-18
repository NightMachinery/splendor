import { test, expect, type Locator, type Page } from "@playwright/test";
import { Actions, TokenType, createBasicGame, type Game } from "./util/game.js";
import { mockGetUsername } from "./util/ls-mock.js";
import { mockGameState } from "./util/server-mock.js";
import { checkActionRequest } from "./util/modal-util.js";

const activate = (control: Locator, touch: boolean) => touch ? control.tap() : control.click();

function atTokenLimit() {
    const game = createBasicGame();
    game.getPlayer("linus").tokens
        .setCount(TokenType.Red, 4)
        .setCount(TokenType.Blue, 3)
        .setCount(TokenType.White, 3);
    return game;
}

async function openReserve(page: Page, game: Game, touch: boolean) {
    await mockGameState(page, game);
    await mockGetUsername(page, "linus");
    await page.goto("/gameboard/?sessionId=123");
    await activate(page.locator("#reserve-btn"), touch);
    const modal = page.locator("#reserve-card-modal");
    await activate(modal.locator('[card-id="01"]'), touch);
    return modal;
}

test("a player at ten tokens must choose which token to return", async ({ page, hasTouch }) => {
    const modal = await openReserve(page, atTokenLimit(), hasTouch);
    const choices = modal.getByRole("group", { name: "At ten tokens, return one to take gold" });
    const reserve = modal.getByRole("button", { name: "Reserve card" });
    await expect(reserve).toBeDisabled();
    await expect(choices.getByRole("radio")).toHaveCount(4);
    await expect(choices.getByRole("radio", { name: "Return 1 green" })).toHaveCount(0);
    await activate(choices.getByRole("radio", { name: "Return 1 blue" }), hasTouch);
    await expect(reserve).toBeEnabled();
    const move = checkActionRequest(page, Actions.RESERVE_CARD);
    await activate(reserve, hasTouch);
    expect((await move).postDataJSON()).toEqual({ cardId: "01", putBackToken: "Blue" });
});

test("a player at ten tokens can leave the gold in the bank", async ({ page, hasTouch }) => {
    const modal = await openReserve(page, atTokenLimit(), hasTouch);
    await activate(modal.getByRole("radio", { name: "Leave gold in bank" }), hasTouch);
    const move = checkActionRequest(page, Actions.RESERVE_CARD);
    await activate(modal.getByRole("button", { name: "Reserve card" }), hasTouch);
    expect((await move).postDataJSON()).toEqual({ cardId: "01", putBackToken: "Gold" });
});

test("an empty bank allows reserving without asking for a return", async ({ page, hasTouch }) => {
    const game = atTokenLimit();
    game.tokens.setCount(TokenType.Gold, 0);
    const modal = await openReserve(page, game, hasTouch);
    await expect(modal.getByRole("status").filter({ hasText: "The bank has no gold." })).toBeVisible();
    await expect(modal.locator("fieldset")).toBeHidden();
    const move = checkActionRequest(page, Actions.RESERVE_CARD);
    await activate(modal.getByRole("button", { name: "Reserve card" }), hasTouch);
    expect((await move).postDataJSON()).toEqual({ cardId: "01" });
});

test("an unavailable return colour clears the choice when the board updates", async ({ page, hasTouch }) => {
    const game = atTokenLimit();
    const modal = await openReserve(page, game, hasTouch);
    const prior = modal.getByRole("radio", { name: "Return 1 blue" });
    await activate(prior, hasTouch);
    const reserve = modal.getByRole("button", { name: "Reserve card" });
    await expect(reserve).toBeEnabled();
    game.getPlayer("linus").tokens.setCount(TokenType.Blue, 0).setCount(TokenType.Green, 3);
    await mockGameState(page, game);
    await expect(prior).toHaveCount(0);
    await expect(reserve).toBeDisabled();
    await expect(modal.getByRole("radio", { name: "Return 1 green" })).toBeVisible();
});
