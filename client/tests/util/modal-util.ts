import { expect, type Locator, type Page } from "@playwright/test";
import { Actions, Game } from "./game.js";
import { mockGameState } from "./server-mock.js";

/** Wait for the client to PUT `action` to the Game Service. */
export const checkActionRequest = (page: Page, action: Actions, timeout = 15_000) => {
    const pending = page.waitForRequest(request => {
        const url = new URL(request.url());
        return url.pathname.endsWith(`/actions/${action}`) && request.method() === "PUT";
    }, { timeout });
    // Callers create this promise before clicking and await it afterwards. If
    // a click fails first, nothing awaits it yet; without a handler the later
    // rejection is unhandled, and under Node 24.4 that aborts the worker
    // (AsyncHooks assertion) instead of reporting the click error.
    pending.catch(() => undefined);
    return pending;
};

/** Pass the turn to the next player and check the modal goes away. */
export const verifyModalCloses = async (page: Page, game: Game, modal: Locator) => {
    game
        .resetValidActions()
        .addDefaultActions()
        .setTurnCounter(1);
    await mockGameState(page, game);

    await expect(modal).toBeHidden();
};
