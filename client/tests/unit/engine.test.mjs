// The offline engine (tests/fixtures/engine.mjs) must reject what the real
// Game Service rejects, without changing the state; otherwise the full-game
// unit tests would prove nothing about the bot's legality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../fixtures/engine.mjs";

const fresh = () => new Engine({ version: "BASE_ORIENT", players: ["a", "b"], seed: 3 });

/** Expect a 400 and an unchanged state. */
const rejects = (engine, name, action, body, why) => {
    const before = engine.text();
    const res = engine.act(name, action, body);
    assert.equal(res.status, 400, `${why}: expected a rejection, got ${res.status}`);
    assert.equal(engine.text(), before, `${why}: a rejected action must not change the state`);
};

test("illegal token takes are rejected and change nothing", () => {
    const e = fresh();
    rejects(e, "a", "TAKE_TOKEN", { takeTokens: { Gold: 1 }, putBackTokens: {} }, "Gold is not takeable");
    rejects(e, "a", "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: { Gold: -2 } }, "negative put-back");
    rejects(e, "a", "TAKE_TOKEN", { takeTokens: { Red: 3 }, putBackTokens: {} }, "three of a colour");
    rejects(e, "a", "TAKE_TOKEN", { takeTokens: { Red: 2, Blue: 1 }, putBackTokens: {} }, "two plus one without the power");
    rejects(e, "a", "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1, White: 1 }, putBackTokens: {} }, "four colours");
    rejects(e, "a", "TAKE_TOKEN", { putBackTokens: {} }, "missing takeTokens");
    rejects(e, "b", "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} }, "not b's turn");
    rejects(e, "a", "CASCADE_1", { cardId: e.state.tier1Deck.visibleCards[0].id }, "cascade not allowed now");
    assert.equal(e.act("a", "TAKE_TOKEN", { takeTokens: { Red: 2 }, putBackTokens: {} }).status, 200);
    // b: the red pile now holds 2, so two red are not allowed
    rejects(e, "b", "TAKE_TOKEN", { takeTokens: { Red: 2 }, putBackTokens: {} }, "two from a pile under 4");
});

test("purchases must pay exactly and only what the player holds", () => {
    const e = fresh();
    const p = e.state.players[0];
    p.tokens.Red = 4; p.tokens.Blue = 4; p.tokens.Green = 2;
    e.state.tokens.Red -= 4; e.state.tokens.Blue -= 4; e.state.tokens.Green -= 2;
    const target = e.state.tier1Deck.visibleCards[0];
    target.tokenCost = { Green: 0, White: 0, Blue: 1, Brown: 0, Red: 2, Satchel: 0, Gold: 0 };
    target.costType = "Token";
    rejects(e, "a", "BUY_CARD", { cardId: target.id, tokens: { Red: 3, Blue: 1 } }, "overpaying");
    rejects(e, "a", "BUY_CARD", { cardId: target.id, tokens: { Red: 1, Blue: 1 } }, "underpaying");
    rejects(e, "a", "BUY_CARD", { cardId: target.id, tokens: { Red: 2, Blue: 1, Gold: -1 } }, "negative gold");
    rejects(e, "a", "BUY_CARD", { cardId: target.id, tokens: { Red: 1, Blue: 1, Gold: 1 } }, "gold the player does not have");
    assert.equal(e.act("a", "BUY_CARD", { cardId: target.id, tokens: { Red: 2, Blue: 1 } }).status, 200);
});

test("cascades take a card of their own tier only", () => {
    const e = fresh();
    e.state.curValidActions = ["CASCADE_1"];
    rejects(e, "a", "CASCADE_1", { cardId: e.state.tier3Deck.visibleCards[0].id }, "tier 3 through CASCADE_1");
    rejects(e, "a", "CASCADE_1", { cardId: e.state.tier2Deck.visibleCards[0].id }, "tier 2 through CASCADE_1");
    assert.equal(e.act("a", "CASCADE_1", { cardId: e.state.tier1Deck.visibleCards[0].id }).status, 200);
});

test("a fourth reserved card is refused", () => {
    const e = fresh();
    for (let i = 0; i < 3; i++) {
        for (const who of ["a", "b"]) assert.equal(e.act(who, "RESERVE_CARD", { cardId: e.state.tier3Deck.visibleCards[0].id }).status, 200);
    }
    rejects(e, "a", "RESERVE_CARD", { cardId: e.state.tier3Deck.visibleCards[0].id }, "fourth reserve");
});

test("the game ends after the last seat of the round, and the most prestige wins", () => {
    const e = fresh();
    const [a, b] = e.state.players;
    a.prestigePoints = 15; // reaches the target first, with no cards
    b.prestigePoints = 18; // overtakes in the same round
    assert.equal(e.act("a", "TAKE_TOKEN", { takeTokens: {}, putBackTokens: {} }).status, 200);
    assert.equal(e.state.gameOver, false, "b still gets their turn");
    assert.equal(e.act("b", "TAKE_TOKEN", { takeTokens: {}, putBackTokens: {} }).status, 200);
    assert.equal(e.state.gameOver, true);
    assert.deepEqual(e.state.winners.map((w) => w.name), ["b"]);
    assert.equal(e.state.turnCounter, -10000);
});
