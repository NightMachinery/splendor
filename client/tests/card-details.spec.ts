import { test, expect, type Locator, type Page } from "@playwright/test";
import { Actions, TokenType, createBasicGame, realCard, type Game } from "./util/game.js";
import { mockGetUsername } from "./util/ls-mock.js";
import { mockGameState } from "./util/server-mock.js";
import { checkActionRequest } from "./util/modal-util.js";

const activate = (control: Locator, touch: boolean) => touch ? control.tap() : control.click();

async function openPurchase(page: Page, game: Game, hasTouch: boolean) {
    await mockGameState(page, game);
    await mockGetUsername(page, "linus");
    await page.goto("/gameboard/?sessionId=123");
    await activate(page.locator("#purchase-btn"), hasTouch);
    return page.locator("#buy-card-modal");
}

test("a player can inspect an Orient card while previewing the board", async ({ page, hasTouch }) => {
    const backend = await mockGameState(page, createBasicGame());
    await mockGetUsername(page, "linus");
    await page.goto("/gameboard/?sessionId=123");
    const turn = page.locator("#your-turn-modal");
    await activate(turn.getByRole("button", { name: "View board" }), hasTouch);
    const card = page.locator('#board [card-id="091"]');
    await expect(card.locator("img")).toBeVisible();
    await activate(card, hasTouch);

    const inspector = page.getByRole("dialog", { name: "Tier 1 Orient card" });
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("Printed purchase cost");
    await expect(inspector).toContainText("0 prestige points");
    await expect(inspector).toContainText("Choose one of your existing gem colours");
    await activate(inspector.getByRole("button", { name: "Close" }), hasTouch);
    await expect(inspector).toBeHidden();
    await activate(turn.getByRole("button", { name: "Return to action" }), hasTouch);
    await expect(turn.getByRole("button", { name: "Get tokens" })).toBeVisible();
    expect(backend.actions).toHaveLength(0);
});

test("a waiting player can open and close card details with the keyboard", async ({ page }) => {
    await mockGameState(page, createBasicGame());
    await mockGetUsername(page, "maex");
    await page.goto("/gameboard/?sessionId=123");
    const card = page.locator('#board [card-id="096"]');
    await card.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Tier 1 Orient card" });
    await expect(dialog).toContainText("2 gold bonuses");
    await expect(dialog).toContainText("Discard this card when you spend either");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(card).toBeFocused();
});

test("history opens revealed cards and keeps their original details after they are used", async ({ page, hasTouch, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 320, height: 650 });
    const game = createBasicGame();
    const backend = await mockGameState(page, game);
    await mockGetUsername(page, "spectator");
    await page.goto("/gameboard/?sessionId=123");
    await expect(page.locator("body")).toHaveAttribute("data-splendor-ready", "1");
    await activate(page.getByRole("button", { name: "History", exact: true }), hasTouch);

    const player = game.getPlayer("linus");
    player.devCards.push(game.tier1OrientDeck.visibleCards.pop()!);
    game.tier1OrientDeck.addOrReplace(realCard("097"));
    backend.setGame(game.setTurnCounter(1));

    const history = page.getByRole("region", { name: "Turn history" });
    const obtained = history.locator(".card-event").filter({ hasText: "Obtained" });
    const card = obtained.getByRole("button", { name: /Inspect tier 1 Orient card/ });
    await expect(card).toBeVisible();
    const target = await card.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(44);
    expect(target?.height).toBeGreaterThanOrEqual(44);
    if (hasTouch) await card.tap();
    else await card.press("Enter");

    const inspector = page.getByRole("dialog", { name: "Tier 1 Orient card" });
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("Printed purchase cost");
    await expect(inspector).toContainText("Discard this card when you spend either");

    player.devCards.pop();
    backend.setGame(game.setTurnCounter(0));
    await expect(page.locator("#history-events .card-event .prefix").filter({ hasText: "Used" })).toBeAttached();
    await expect(inspector).toBeVisible();
    await activate(inspector.getByRole("button", { name: "Close" }), hasTouch);

    const used = history.locator(".card-event").filter({ hasText: "Used" });
    await activate(used.getByRole("button", { name: /Inspect tier 1 Orient card/ }), hasTouch);
    await expect(inspector).toContainText("2 gold bonuses");
    await activate(inspector.getByRole("button", { name: "Close" }), hasTouch);

    player.reservedCards.push(game.tier1OrientDeck.visibleCards.shift()!);
    game.tier1OrientDeck.addOrReplace(realCard("095"));
    backend.setGame(game.setTurnCounter(1));
    const reserved = history.locator(".card-event").filter({ hasText: "Reserved" });
    const reservedCard = reserved.getByRole("button", { name: /Inspect tier 1 Orient card/ });
    await expect(reservedCard).toHaveAttribute("card-id", "091");
    await activate(reservedCard, hasTouch);
    await expect(inspector).toContainText("Choose one of your existing gem colours");
    expect(backend.actions).toHaveLength(0);
});

test("history and its card details survive a reload and clear when the game restarts", async ({ page, hasTouch }) => {
    const game = createBasicGame();
    const state = () => ({ ...game, gameInstanceId: "first-game" });
    const backend = await mockGameState(page, state());
    await mockGetUsername(page, "spectator");
    await page.goto("/gameboard/?sessionId=123");
    await expect(page.locator("body")).toHaveAttribute("data-splendor-ready", "1");

    const history = page.getByRole("region", { name: "Turn history" });
    const openHistory = page.getByRole("button", { name: "History", exact: true });
    const headings = history.locator(".event-name");
    const card = history.getByRole("button", { name: /Inspect tier 1 Orient card/ });
    game.getPlayer("linus").reservedCards.push(game.tier1OrientDeck.visibleCards.pop()!);
    game.tier1OrientDeck.addOrReplace(realCard("097"));
    game.setTurnCounter(1);
    backend.setGame(state());
    await activate(openHistory, hasTouch);
    await expect(headings).toHaveText(["linus’s turn", "maex’s turn"]);
    await expect(card).toHaveCount(1);

    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-splendor-ready", "1");
    await activate(openHistory, hasTouch);
    await expect(headings).toHaveText(["linus’s turn", "maex’s turn"]);
    await activate(card, hasTouch);
    const inspector = page.getByRole("dialog", { name: "Tier 1 Orient card" });
    await expect(inspector).toContainText("Discard this card when you spend either");
    await activate(inspector.getByRole("button", { name: "Close" }), hasTouch);

    await page.goto("about:blank");
    game.getPlayer("maex").tokens.setCount(TokenType.Red, 2);
    game.setTurnCounter(0);
    backend.setGame(state());
    await page.goto("/gameboard/?sessionId=123");
    await expect(page.locator("body")).toHaveAttribute("data-splendor-ready", "1");
    await activate(openHistory, hasTouch);
    await expect(headings).toHaveText(["linus’s turn", "maex’s turn", "linus’s turn"]);
    await expect(history.locator(".token-event")).toHaveText("Took 2 red");
    await expect(card).toHaveCount(1);

    backend.setGame({ ...createBasicGame(), gameInstanceId: "restarted-game" });
    await expect(headings).toHaveText(["linus’s turn"]);
    await expect(card).toHaveCount(0);
    await expect(history.locator(".token-event")).toHaveCount(0);
});

test("purchase suggests the reduced cost and submits an edited payment", async ({ page, hasTouch }) => {
    const game = createBasicGame();
    game.getPlayer("linus").reservedCards.push(realCard("05"));
    game.getPlayer("linus").bonuses.setCount(TokenType.Blue, 1);
    game.getPlayer("linus").tokens.setCount(TokenType.Blue, 3);
    game.getPlayer("linus").tokens.setCount(TokenType.Gold, 1);
    const purchase = await openPurchase(page, game, hasTouch);
    const card = purchase.locator('.reserved-cards [card-id="05"]');
    await activate(card, hasTouch);
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(purchase.locator(".card-readout")).toContainText("1 brown bonus");
    await expect(purchase.locator(".card-readout")).toContainText("After your gem bonuses");
    await expect(purchase.locator(".card-readout")).toContainText("3 Blue");
    await activate(purchase.locator("#buy-card-confirm-btn"), hasTouch);
    const payment = page.locator("#dev-card-payment-modal");
    await expect(payment.locator(".card-readout")).toContainText("3 Blue");
    const buy = payment.getByRole("button", { name: "Buy card" });
    const summary = payment.getByRole("status");
    await expect(summary).toHaveText("Pay 3 Blue.");
    const removeBlue = payment.getByRole("button", { name: "Remove blue" });
    await activate(removeBlue, hasTouch);
    await expect(buy).toBeDisabled();
    await activate(payment.getByRole("button", { name: "Reset to suggestion" }), hasTouch);
    await expect(buy).toBeEnabled();
    await expect(summary).toHaveText("Pay 3 Blue.");

    await activate(removeBlue, hasTouch);
    await activate(payment.getByRole("button", { name: "Add gold" }), hasTouch);
    await expect(summary).toHaveText("Pay 2 Blue and 1 Gold.");
    const move = checkActionRequest(page, Actions.BUY_CARD);
    await activate(buy, hasTouch);
    expect((await move).postDataJSON()).toMatchObject({ cardId: "05", tokens: { Blue: 2, Gold: 1 } });
});

test("editing a payment warns when the server will discard a double-gold card", async ({ page, hasTouch }) => {
    const game = createBasicGame();
    const player = game.getPlayer("linus");
    player.reservedCards.push(realCard("05"));
    player.devCards.push(realCard("047"), realCard("097"));
    player.bonuses.setCount(TokenType.Blue, 1).setCount(TokenType.Gold, 2);
    player.tokens.setCount(TokenType.Blue, 2).setCount(TokenType.Gold, 1);
    const purchase = await openPurchase(page, game, hasTouch);
    await activate(purchase.locator('[card-id="05"]'), hasTouch);
    await activate(purchase.locator("#buy-card-confirm-btn"), hasTouch);
    const payment = page.locator("#dev-card-payment-modal");
    const warning = payment.locator("[data-payment-discard]");
    await expect(payment.getByRole("status")).toHaveText("Pay 2 Blue and 1 Gold.");
    await expect(warning).toBeHidden();
    await activate(payment.getByRole("button", { name: "Remove gold" }), hasTouch);
    await expect(warning).toHaveText("This will discard 1 double-gold card.");
    await expect(payment.getByRole("button", { name: "Buy card" })).toBeEnabled();
});

test("a sacrifice warns about the cards and prestige spent while offering zero tokens", async ({ page, hasTouch }) => {
    const game = createBasicGame();
    const player = game.getPlayer("linus");
    player.devCards.push(realCard("047"), realCard("07"));
    player.bonuses.setCount(TokenType.Blue, 2);
    player.tokens.setCount(TokenType.Blue, 4);
    const purchase = await openPurchase(page, game, hasTouch);
    await activate(purchase.locator('[card-id="111"]'), hasTouch);
    await activate(purchase.locator("#buy-card-confirm-btn"), hasTouch);
    const payment = page.locator("#dev-card-payment-modal");
    await expect(payment.getByRole("status")).toContainText("No tokens needed.");
    await expect(payment.locator("[data-payment-discard]")).toHaveText("You will discard 2 blue bonus cards and lose 1 prestige point.");
    await expect(payment.locator("fieldset")).toBeHidden();
    const move = checkActionRequest(page, Actions.BUY_CARD);
    await activate(payment.getByRole("button", { name: "Buy card" }), hasTouch);
    expect((await move).postDataJSON()).toEqual({
        cardId: "111",
        tokens: { White: 0, Blue: 0, Green: 0, Red: 0, Brown: 0, Gold: 0 },
    });
});

test("comparing two cards in Reserve submits only the final selection", async ({ page, hasTouch }) => {
    await mockGameState(page, createBasicGame());
    await mockGetUsername(page, "linus");
    await page.goto("/gameboard/?sessionId=123");
    await activate(page.locator("#reserve-btn"), hasTouch);
    const reserve = page.locator("#reserve-card-modal");
    const sacrificeCard = reserve.locator('[card-id="111"]');
    const reserveNobleCard = reserve.locator('[card-id="106"]');
    await activate(sacrificeCard, hasTouch);
    await expect(reserve.locator(".card-readout")).toContainText("Bonuses to discard");
    await activate(reserveNobleCard, hasTouch);
    await expect(sacrificeCard).toHaveAttribute("aria-pressed", "false");
    await expect(reserveNobleCard).toHaveAttribute("aria-pressed", "true");
    await expect(reserve.locator(".card-readout")).toContainText("Reserve a noble from the board");
    const move = checkActionRequest(page, Actions.RESERVE_CARD);
    await activate(reserve.locator("#reserve-card-confirm-btn"), hasTouch);
    expect((await move).postDataJSON()).toEqual({ cardId: "106" });
});
