// Unit tests for the shared board rule helpers (src/scripts/sp/rules-common.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    GEMS, TOKEN_KEYS, SEAT_PALETTE,
    amount, total, goldValue, ownsGemBonusCard, hasDoublePlusOne, currentPlayer, findPlayer, phaseOf,
    seatColour, seatColours, cardById, locateCard, followUpOf, fullTokenMap, cardTags, cascadeChoices,
    satchelColours, unassignedSatchel, tierOf, marketCards,
} from "../../src/scripts/sp/rules-common.js";
import { Engine } from "../fixtures/engine.mjs";
import { game, player, card } from "../fixtures/states.mjs";

test("GEMS is the display order and TOKEN_KEYS adds Gold, never Satchel", () => {
    assert.deepEqual([...GEMS], ["White", "Blue", "Green", "Red", "Brown"]);
    assert.deepEqual([...TOKEN_KEYS], ["White", "Blue", "Green", "Red", "Brown", "Gold"]);
    assert.deepEqual(Object.keys(fullTokenMap({ Red: 2, Satchel: 1 })), [...TOKEN_KEYS]);
    assert.equal(fullTokenMap({ Red: 2 }).Red, 2);
});

test("missing or malformed fields count as 0", () => {
    assert.equal(amount(undefined, "Red"), 0);
    assert.equal(amount({ Red: "3" }, "Red"), 0);
    assert.equal(amount({ Red: NaN }, "Red"), 0);
    assert.equal(amount({ Red: 3 }, "Red"), 3);
    assert.equal(total({ Red: 3, Blue: 2, Gold: null }), 5);
    assert.equal(total(null), 0);
});

test("gold value, gem-card ownership and the double-plus-one power", () => {
    assert.equal(goldValue({}), 1);
    assert.equal(goldValue(player("p", { version: "BASE_ORIENT_TRADE_ROUTES" })), 1);
    assert.equal(goldValue(player("p", { version: "BASE_ORIENT_TRADE_ROUTES", powers: ["goldTokenWorthTwoTokens"] })), 2);
    assert.equal(ownsGemBonusCard(player("p")), false);
    assert.equal(ownsGemBonusCard(player("p", { cards: ["096"] })), false, "a double-gold card is no gem card");
    assert.equal(ownsGemBonusCard(player("p", { cards: ["091"] })), false, "an unassigned satchel is no gem card");
    assert.equal(ownsGemBonusCard(player("p", { cards: ["01"] })), true);
    assert.equal(hasDoublePlusOne(player("p", { version: "BASE_ORIENT_TRADE_ROUTES", powers: ["extraTokenAfterTakingSameColor"] })), true);
    assert.equal(hasDoublePlusOne(player("p")), false);
});

test("currentPlayer and findPlayer", () => {
    const s = game({ turn: 1 });
    assert.equal(currentPlayer(s).name, "bob");
    assert.equal(findPlayer(s, "alice").name, "alice");
    assert.equal(findPlayer(s, "zed"), null);
    assert.equal(currentPlayer({ ...s, gameOver: true, turnCounter: -10000 }), null);
    assert.equal(currentPlayer(null), null);
});

test("phaseOf covers every phase, game over first", () => {
    assert.equal(phaseOf(null, "alice"), "loading");
    assert.equal(phaseOf({}, "alice"), "loading");
    const s = game();
    assert.equal(phaseOf(s, "alice"), "mine");
    assert.equal(phaseOf(s, "bob"), "other");
    assert.equal(phaseOf(s, "watcher"), "spectator");
    assert.equal(phaseOf(s, undefined), "spectator");
    assert.equal(phaseOf(game({ actions: ["CHOOSE_SATCHEL_TOKEN"] }), "alice"), "followup");
    assert.equal(phaseOf(game({ actions: ["CHOOSE_SATCHEL_TOKEN"] }), "bob"), "other");
    const over = { ...s, gameOver: true, turnCounter: -10000, curValidActions: [] };
    assert.equal(phaseOf(over, "alice"), "over");
    assert.equal(phaseOf(over, "watcher"), "over", "spectators see the game over too");
    assert.equal(phaseOf(s, { name: "alice" }), "mine", "a player object works as well");
    assert.equal(followUpOf(game({ actions: ["CASCADE_1"] })), "CASCADE_1");
    assert.equal(followUpOf(s), null);
});

test("phaseOf agrees with the engine's turn order over a short game", () => {
    const e = new Engine({ version: "BASE_ORIENT", players: ["a", "b", "c"], seed: 4 });
    for (let i = 0; i < 6; i++) {
        const s = e.json();
        const cur = s.players[s.turnCounter].name;
        for (const p of s.players) assert.equal(phaseOf(s, p.name), p.name === cur ? "mine" : "other");
        assert.equal(e.act(cur, "TAKE_TOKEN", { takeTokens: {}, putBackTokens: {} }).status, 200);
    }
});

test("seatColour adds the '#', and duplicate or invalid colours fall back to the seat palette", () => {
    const s = game({ players: [player("a"), player("b"), player("c"), player("d")] });
    // the fixtures give every player 1E90FF
    assert.deepEqual(seatColours(s), ["#1e90ff", SEAT_PALETTE[1], SEAT_PALETTE[2], SEAT_PALETTE[3]]);
    assert.equal(seatColour(s, "a"), "#1e90ff");
    assert.equal(seatColour(s, "nobody"), null);
    s.players[0].colour = "not a colour"; // invalid: seat 0 takes its palette colour
    s.players[1].colour = "#3B82F6"; // valid, but seat 0 already shows it
    assert.deepEqual(seatColours(s), ["#3b82f6", "#ef4444", "#1e90ff", "#a855f7"]);
    s.players[2].colour = "a855f7";
    s.players[3].colour = "A855F7"; // same colour, other case; its own palette colour is taken too
    assert.deepEqual(seatColours(s), ["#3b82f6", "#ef4444", "#a855f7", "#22c55e"]);
});

test("cardById and locateCard search the market, reserves and tableaux", () => {
    const s = game({ players: [player("alice", { reserved: ["05"], cards: ["06"] }), player("bob")] });
    assert.equal(cardById(s, "01").id, "01");
    assert.deepEqual({ ...locateCard(s, "01"), card: undefined }, { card: undefined, where: "market", deck: "tier1Deck" });
    assert.equal(locateCard(s, "05").where, "reserved");
    assert.equal(locateCard(s, "05").owner, "alice");
    assert.equal(locateCard(s, "06").where, "owned");
    assert.equal(cardById(s, "nope"), null);
    assert.equal(cardById(s, 1), null);
    assert.equal(marketCards(s).length, 18);
    assert.equal(tierOf(card("041")), 2);
    assert.equal(tierOf({}), 0);
});

test("cardTags names the Orient effects", () => {
    assert.deepEqual(cardTags(card("01")), []);
    assert.deepEqual(cardTags(card("091")), ["satchel"]);
    assert.deepEqual(cardTags(card("096")), ["double-gold"]);
    assert.deepEqual(cardTags(card("106")), ["reserve-noble"]);
    assert.deepEqual(cardTags(card("109")), ["cascade", "satchel"]);
    assert.deepEqual(cardTags(card("111")), ["sacrifice"]);
    assert.deepEqual(cardTags(card("116")), ["cascade"]);
});

test("cascadeChoices and satchelColours mirror the engine", () => {
    const s = game();
    const noGem = player("alice");
    assert.ok(cascadeChoices(s, noGem, 1).every((c) => c.tokenType !== "Satchel"));
    const e = new Engine({ version: "BASE_ORIENT", players: ["alice", "bob"] });
    e.state = structuredClone(s);
    for (const p of [noGem, player("alice", { cards: ["01"] })]) {
        for (const tier of [1, 2]) {
            assert.deepEqual(cascadeChoices(s, p, tier).map((c) => c.id), e.cascadeChoices(p, `TIER_${tier}`).map((c) => c.id));
            assert.deepEqual(cascadeChoices(s, p, `CASCADE_${tier}`).map((c) => c.id), e.cascadeChoices(p, `TIER_${tier}`).map((c) => c.id));
        }
    }
    assert.deepEqual(cascadeChoices(s, noGem, 3), []);
    const satchel = card("091");
    const owner = player("alice", { cards: ["01", "02", "096"] });
    owner.devCards.push(satchel);
    assert.deepEqual(satchelColours(owner), ["White", "Blue"], "card colours only, no Gold");
    assert.equal(unassignedSatchel(owner).id, "091");
    satchel.tokenType = "Red";
    assert.deepEqual(satchelColours(owner), ["White", "Blue", "Red"], "an assigned satchel counts as its colour");
    assert.equal(unassignedSatchel(owner), null);
});
