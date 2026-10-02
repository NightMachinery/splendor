// Unit tests for the bot's move choice (tests/e2e/lib/bot.mjs) on hand-built
// states in the real Game Service JSON shape (tests/fixtures/states.mjs).
// Run: pnpm run test:unit   (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAction, paymentFor, total, GEMS } from "../e2e/lib/bot.mjs";
import { game, player, tokens, card } from "../fixtures/states.mjs";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const isGemMap = (m) => Object.keys(m).every((k) => GEMS.includes(k));

/** A legal TAKE_TOKEN shape under the official rules (no Trading Posts power). */
const assertLegalTake = (state, me, body) => {
    const take = body.takeTokens;
    assert.ok(isGemMap(take), `only gems may be taken, got ${JSON.stringify(take)}`);
    const amounts = Object.values(take);
    assert.ok(amounts.every((a) => Number.isInteger(a) && a >= 0), "whole non-negative amounts");
    if (amounts.includes(2)) {
        assert.equal(amounts.length, 1, "two of a colour means nothing else");
        const [colour] = Object.keys(take);
        assert.ok(state.tokens[colour] >= 4, `two ${colour} only from a pile of 4 or more (pile ${state.tokens[colour]})`);
    } else {
        assert.ok(amounts.every((a) => a === 1) && amounts.length <= 3, "up to 3 different gems");
    }
    for (const [t, a] of Object.entries(take)) assert.ok(state.tokens[t] >= a, `the bank has ${state.tokens[t]} ${t}`);
    const back = body.putBackTokens;
    const after = total(me.tokens) + total(take) - total(back);
    assert.ok(after <= 10, `ends with ${after} tokens`);
    if (total(back) > 0) assert.equal(after, 10, "tokens are only returned down to exactly 10");
    for (const [t, a] of Object.entries(back)) {
        assert.notEqual(t, "Satchel");
        assert.ok(a >= 0 && me.tokens[t] >= a, `returns ${a} ${t} out of ${me.tokens[t]} held before the take`);
    }
};

test("the opening move takes legal gems and never Gold", () => {
    let takes = 0;
    for (const seed of SEEDS) {
        const state = game();
        const move = nextAction(state, "alice", { seed });
        // The bot now and then (5%) reserves for the gold instead; that is a
        // legal opening too, so only check it is a plain reserve from the board.
        if (move.action === "RESERVE_CARD") {
            assert.ok(state.tier1Deck.visibleCards.concat(state.tier2Deck.visibleCards, state.tier3Deck.visibleCards)
                .some((c) => c.id === move.body.cardId), move.reason);
            continue;
        }
        assert.equal(move.action, "TAKE_TOKEN", move.reason);
        takes++;
        assertLegalTake(state, state.players[0], move.body);
        assert.equal(total(move.body.putBackTokens), 0);
        assert.ok(total(move.body.takeTokens) >= 2);
    }
    assert.ok(takes >= SEEDS.length - 2, `only ${takes} of ${SEEDS.length} openings took gems`);
});

test("tokens above 10 go back, down to exactly 10, from tokens held before the take", () => {
    for (const seed of SEEDS) {
        const alice = player("alice", { tokens: { Red: 3, Blue: 3, Green: 3 }, reserved: ["072", "073", "074"] });
        const state = game({ players: [alice, player("bob")], board: { tier3Deck: ["071"] } });
        const move = nextAction(state, "alice", { seed });
        assert.equal(move.action, "TAKE_TOKEN", move.reason);
        assertLegalTake(state, alice, move.body);
        assert.equal(total(alice.tokens) + total(move.body.takeTokens) - total(move.body.putBackTokens), 10);
        assert.equal(move.body.putBackTokens.Gold ?? 0, 0, "gems go back before gold");
    }
});

test("two of one colour only when the target lacks just that colour and the pile has 4", () => {
    const reserved = ["071", "072", "073"]; // too dear to aim for; also blocks reserving
    for (const seed of SEEDS) {
        const four = game({ players: [player("alice", { reserved }), player("bob")], board: { tier1Deck: ["02"] } });
        const move = nextAction(four, "alice", { seed });
        assert.deepEqual(move.body.takeTokens, { Red: 2 }, move.reason);

        const three = game({
            players: [player("alice", { reserved }), player("bob", { tokens: { Red: 1 } })],
            board: { tier1Deck: ["02"] },
        });
        const m3 = nextAction(three, "alice", { seed });
        assert.equal(m3.action, "TAKE_TOKEN");
        assert.ok(!Object.values(m3.body.takeTokens).includes(2), `pile of 3: ${m3.reason}`);
        assert.equal(m3.body.takeTokens.Red, 1, "still takes the colour it needs");
        assertLegalTake(three, three.players[0], m3.body);
    }
});

test("a purchase pays exactly: bonuses first, then gems, then gold", () => {
    const alice = player("alice", { cards: ["03"], tokens: { Green: 2, Gold: 2 } }); // Green bonus 1
    const state = game({ players: [alice, player("bob")], board: { tier1Deck: ["01"] } }); // 01 costs Green 4
    for (const seed of SEEDS) {
        const move = nextAction(state, "alice", { seed });
        assert.equal(move.action, "BUY_CARD", move.reason);
        assert.deepEqual(move.body, { cardId: "01", tokens: { Green: 2, Gold: 1 } });
    }
});

test("Trading Posts power 3 makes one gold pay for two gems", () => {
    const version = "BASE_ORIENT_TRADE_ROUTES";
    const withPower = player("alice", { version, powers: ["goldTokenWorthTwoTokens"], tokens: { Gold: 2 } });
    const state = game({ version, players: [withPower, player("bob", { version })], board: { tier1Deck: ["01"] } });
    assert.deepEqual(nextAction(state, "alice", { seed: 1 }).body, { cardId: "01", tokens: { Gold: 2 } });

    const without = player("alice", { version, tokens: { Gold: 2 } });
    assert.equal(paymentFor(card("01"), without), null, "4 green need 4 gold without the power");
});

test("a Satchel card is only bought by a player who owns a gem-bonus card", () => {
    const board = { tier1OrientDeck: ["091"] }; // Satchel, costs Blue 2 Red 3
    for (const seed of SEEDS) {
        const bare = game({ players: [player("alice", { tokens: { Blue: 2, Red: 3 } }), player("bob")], board });
        assert.notEqual(nextAction(bare, "alice", { seed }).action, "BUY_CARD");
    }
    const owner = game({ players: [player("alice", { cards: ["03"], tokens: { Blue: 2, Red: 3 } }), player("bob")], board });
    assert.deepEqual(nextAction(owner, "alice", { seed: 1 }).body, { cardId: "091", tokens: { Blue: 2, Red: 3 } });
});

test("a Bonus-cost card is bought with bonuses only, offering no tokens", () => {
    const board = { tier3OrientDeck: ["111"] }; // 3 points, costs 2 Blue bonuses
    const rich = game({ players: [player("alice", { cards: ["07", "012"], tokens: { Blue: 3 } }), player("bob")], board });
    assert.deepEqual(nextAction(rich, "alice", { seed: 1 }).body, { cardId: "111", tokens: {} });
    for (const seed of SEEDS) {
        const poor = game({ players: [player("alice", { cards: ["07"], tokens: { Blue: 5 } }), player("bob")], board });
        assert.notEqual(nextAction(poor, "alice", { seed }).action, "BUY_CARD", "one Blue bonus is not enough; tokens do not count");
    }
});

test("never reserves a fourth card; passes when nothing else is legal", () => {
    const alice = player("alice", { reserved: ["071", "072", "073"] });
    const state = game({ players: [alice, player("bob")], board: { tier3Deck: ["074"] }, bank: tokens({ Gold: 5 }) });
    for (const seed of SEEDS) {
        const move = nextAction(state, "alice", { seed });
        assert.deepEqual(move, { action: "TAKE_TOKEN", body: { takeTokens: {}, putBackTokens: {} }, reason: move.reason });
    }
});

test("reserving at 10 tokens takes the gold and returns one token", () => {
    const alice = player("alice", { tokens: { Red: 4, Blue: 4, Green: 2 } });
    const state = game({ players: [alice, player("bob")], board: { tier3Deck: ["071"] }, bank: tokens({ Gold: 5 }) });
    const move = nextAction(state, "alice", { seed: 1 });
    assert.equal(move.action, "RESERVE_CARD", move.reason);
    assert.equal(move.body.cardId, "071");
    assert.ok(GEMS.includes(move.body.putBackToken) && alice.tokens[move.body.putBackToken] > 0, JSON.stringify(move.body));
});

test("CASCADE_1 takes a tier-1 card, never a better card of another tier", () => {
    const board = { tier1Deck: ["01"], tier1OrientDeck: ["096"], tier2Deck: ["041"], tier3Deck: ["071"] };
    for (const seed of SEEDS) {
        const state = game({ board, actions: ["CASCADE_1"] });
        const move = nextAction(state, "alice", { seed });
        assert.equal(move.action, "CASCADE_1");
        assert.ok(["01", "096"].includes(move.body.cardId), move.reason);
    }
});

test("CASCADE_1 skips a Satchel card when the player has no gem-bonus card", () => {
    for (const seed of SEEDS) {
        const state = game({ board: { tier1OrientDeck: ["091", "096"] }, actions: ["CASCADE_1"] });
        assert.equal(nextAction(state, "alice", { seed }).body.cardId, "096");
    }
});

test("CASCADE_2 takes a tier-2 card", () => {
    const board = { tier1Deck: ["01"], tier2Deck: ["041"], tier2OrientDeck: ["101"], tier3Deck: ["071"], tier3OrientDeck: ["116"] };
    for (const seed of SEEDS) {
        const move = nextAction(game({ board, actions: ["CASCADE_2"] }), "alice", { seed });
        assert.ok(["041", "101"].includes(move.body.cardId), move.reason);
    }
});

test("follow-ups come first and are answered with a legal choice", () => {
    // CHOOSE_NOBLE: only a noble the player qualifies for, on the board or reserved
    const qualifier = player("alice", { bonuses: { Green: 4, Blue: 4 } });
    let state = game({ players: [qualifier, player("bob")], board: { nobleDeck: ["20002", "20004"] }, actions: ["CHOOSE_NOBLE"] });
    assert.deepEqual(nextAction(state, "alice", { seed: 1 }).body, { cardId: "20002" });
    const reserver = player("alice", { bonuses: { White: 4, Brown: 4 }, reservedNobles: ["20005"] });
    state = game({ players: [reserver, player("bob")], board: { nobleDeck: ["20002"] }, actions: ["CHOOSE_NOBLE"] });
    assert.deepEqual(nextAction(state, "alice", { seed: 1 }).body, { cardId: "20005" });

    // RESERVE_NOBLE: a noble on the board
    state = game({ board: { nobleDeck: ["20003", "20004"] }, actions: ["RESERVE_NOBLE"] });
    assert.ok(["20003", "20004"].includes(nextAction(state, "alice", { seed: 2 }).body.cardId));

    // CHOOSE_SATCHEL_TOKEN: the unassigned satchel, as a colour the player owns
    state = game({ players: [player("alice", { cards: ["03", "091"] }), player("bob")], actions: ["CHOOSE_SATCHEL_TOKEN"] });
    assert.deepEqual(nextAction(state, "alice", { seed: 1 }).body, { cardId: "091", selected: "Green" });

    // CHOOSE_CITY: a city the player qualifies for
    const version = "BASE_ORIENT_CITIES";
    const mayor = player("alice", { version, prestigePoints: 17, bonuses: { Brown: 3, Red: 4 } });
    state = game({ version, players: [mayor, player("bob", { version })], cities: ["40001", "40003", "40007"], actions: ["CHOOSE_CITY"] });
    assert.ok(["40001", "40003"].includes(nextAction(state, "alice", { seed: 1 }).body.cityId));
});

test("the Trading Posts extra token is a gem in stock and never breaks the 10-token limit", () => {
    const version = "BASE_ORIENT_TRADE_ROUTES";
    const actions = ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"];
    let state = game({ version, players: [player("alice", { version }), player("bob", { version })], bank: tokens({ Red: 2, Gold: 5 }), actions });
    assert.deepEqual(nextAction(state, "alice", { seed: 1 }).body, { takeToken: "Red" });

    state = game({ version, players: [player("alice", { version }), player("bob", { version })], bank: tokens({ Gold: 5 }), actions });
    assert.deepEqual(nextAction(state, "alice", { seed: 1 }).body, {}, "nothing to take: skip");

    for (const seed of SEEDS) {
        const full = player("alice", { version, tokens: { White: 5, Blue: 5 }, reserved: ["01"] }); // 01 needs Green
        state = game({ version, players: [full, player("bob", { version })], bank: tokens({ Green: 3, Gold: 5 }), actions });
        const body = nextAction(state, "alice", { seed }).body;
        if (body.takeToken) {
            assert.equal(body.takeToken, "Green");
            assert.ok(["White", "Blue"].includes(body.putBackToken), "at 10 tokens a take needs a return");
        } else {
            assert.deepEqual(body, {});
        }
    }
});

test("moves are deterministic per seed, and null when it is not the player's move", () => {
    const state = game();
    assert.deepEqual(nextAction(state, "alice", { seed: 7 }), nextAction(structuredClone(state), "alice", { seed: 7 }));
    assert.equal(nextAction(state, "bob", { seed: 7 }), null);
    assert.equal(nextAction({ ...state, gameOver: true, turnCounter: -10000, curValidActions: [] }, "alice"), null);
});
