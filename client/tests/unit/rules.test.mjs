// Unit tests for the rule helpers and invariant checks (tests/e2e/lib/rules.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    expectedWinners, paymentFor, stateViolations, initialStateViolations, finalStateViolations,
    GAME_VERSIONS, tokenSupply, qualifiesForCity,
} from "../e2e/lib/rules.mjs";
import { Engine } from "../fixtures/engine.mjs";
import { game, player, card } from "../fixtures/states.mjs";

const finished = (players, version = "BASE_ORIENT") => ({
    ...game({ version, players }),
    gameOver: true, turnCounter: -10000, curValidActions: [],
});

test("more prestige beats fewer cards in the winner rule", () => {
    // The old server bug: among qualifiers, the fewest dev cards won regardless of points.
    const p1 = player("p1", { prestigePoints: 15, cards: ["06", "07"] });
    const p2 = player("p2", { prestigePoints: 20, cards: ["06", "07", "08", "09"] });
    assert.deepEqual(expectedWinners(finished([p1, p2])), ["p2"]);
});

test("a tie on points goes to the fewest cards; a full tie is shared", () => {
    const a = player("a", { prestigePoints: 16, cards: ["06", "07", "08"] });
    const b = player("b", { prestigePoints: 16, cards: ["06", "07"] });
    const c = player("c", { prestigePoints: 12, cards: [] });
    assert.deepEqual(expectedWinners(finished([a, b, c])), ["b"]);
    const d = player("d", { prestigePoints: 16, cards: ["06", "07"] });
    assert.deepEqual(expectedWinners(finished([b, d])), ["b", "d"]);
});

test("in Cities games only city holders qualify", () => {
    const version = "BASE_ORIENT_CITIES";
    const rich = player("rich", { version, prestigePoints: 20 });
    const mayor = player("mayor", { version, prestigePoints: 13, cities: ["40001"] });
    assert.deepEqual(expectedWinners(finished([rich, mayor], version)), ["mayor"]);
});

test("city qualification counts the same-colour requirement on gems the city does not name", () => {
    const city = card("40008"); // 12 points, 6 bonuses of one colour
    assert.ok(qualifiesForCity({ prestigePoints: 12, bonuses: { Red: 6 } }, city));
    assert.ok(!qualifiesForCity({ prestigePoints: 12, bonuses: { Gold: 6 } }, city), "gold never counts");
    assert.ok(!qualifiesForCity({ prestigePoints: 11, bonuses: { Red: 6 } }, city));
    const named = card("40009"); // 14 points, Green 4 and 4 of another colour
    assert.ok(!qualifiesForCity({ prestigePoints: 14, bonuses: { Green: 8 } }, named), "the named colour does not double as the same colour");
    assert.ok(qualifiesForCity({ prestigePoints: 14, bonuses: { Green: 4, Blue: 4 } }, named));
});

test("paymentFor never overpays and spends gold bonuses only for a shortfall", () => {
    // 013 costs Red 3; a double-gold card (096) gives 2 gold bonuses
    const p = player("p", { cards: ["096"], tokens: { Red: 1 } });
    assert.deepEqual(paymentFor(card("013"), p), { tokens: { Red: 1 }, spent: 1, goldTokens: 0, goldBonusesUsed: 2, bonusCost: false });
    const q = player("q", { cards: ["096"], tokens: { Red: 5, Gold: 3 } });
    assert.deepEqual(paymentFor(card("013"), q).tokens, { Red: 3 }, "gems before gold, no more than owed");
    assert.equal(paymentFor(card("013"), player("r", { cards: ["096"] })), null, "3 owed, 2 gold bonuses");
});

test("every freshly dealt game passes the setup checks", () => {
    for (const version of GAME_VERSIONS) {
        for (const n of [2, 3, 4]) {
            const e = new Engine({ version, players: Array.from({ length: n }, (_, i) => `p${i}`), seed: n });
            assert.deepEqual(initialStateViolations(e.json(), { version, players: n }), [], `${version} ${n}p`);
        }
    }
    assert.deepEqual(tokenSupply(2), { Green: 4, White: 4, Blue: 4, Brown: 4, Red: 4, Satchel: 0, Gold: 5 });
});

test("setup checks catch nobles in the no-nobles Cities game and a wrong pile size", () => {
    const e = new Engine({ version: "BASE_ORIENT_CITIES_NOBLES", players: ["a", "b"] });
    const s = e.json();
    s.gameVersion = "BASE_ORIENT_CITIES";
    assert.ok(initialStateViolations(s, { version: "BASE_ORIENT_CITIES", players: 2 }).some((m) => m.includes("nobles dealt")));
    const t = new Engine({ version: "BASE_ORIENT", players: ["a", "b"] }).json();
    t.tokens.Red = 5;
    assert.ok(initialStateViolations(t, { players: 2 }).some((m) => m.includes("Red")));
});

test("state checks catch leaked tokens, hoarding, over-reserving, bad bonuses and duplicated cards", () => {
    const base = new Engine({ version: "BASE_ORIENT", players: ["a", "b"] }).json();
    assert.deepEqual(stateViolations(base), []);

    const leak = structuredClone(base);
    leak.players[0].tokens.Gold = 1;
    assert.ok(stateViolations(leak).some((m) => m.startsWith("Gold tokens are not conserved")));

    const hoard = structuredClone(base);
    hoard.players[0].tokens = { ...hoard.players[0].tokens, Red: 4, Blue: 4, Green: 3 };
    for (const t of ["Red", "Blue", "Green"]) hoard.tokens[t] -= hoard.players[0].tokens[t];
    assert.deepEqual(stateViolations(hoard), ["a holds 11 tokens (max 10)"]);

    const reserve = structuredClone(base);
    reserve.players[1].reservedCards = ["071", "072", "073", "074"].map(card);
    assert.ok(stateViolations(reserve).includes("b has 4 reserved cards (max 3)"));

    const bonus = structuredClone(base);
    bonus.players[0].bonuses.Red = 1;
    assert.ok(stateViolations(bonus).some((m) => m.includes("Red bonuses")));

    const dup = structuredClone(base);
    dup.players[0].devCards.push(structuredClone(dup.tier1Deck.visibleCards[0]));
    const msgs = stateViolations(dup);
    assert.ok(msgs.some((m) => m.includes("is both in tier1Deck")), msgs.join("; "));
});

test("final checks need a winner chosen by the official rule", () => {
    const p1 = player("p1", { prestigePoints: 15, cards: [] });
    const p2 = player("p2", { prestigePoints: 18, cards: [] });
    const state = finished([p1, p2]);
    state.winners = [p1];
    // prestige does not match the (empty) cards here, so look only at the winner message
    assert.ok(finalStateViolations(state).some((m) => m.startsWith('winners are ["p1"], the rules say ["p2"]')));
    state.winners = [];
    assert.ok(finalStateViolations(state).includes("the game is over but nobody won"));
});
