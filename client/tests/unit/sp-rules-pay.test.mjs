// Unit tests for payment, affordability, reserve and sacrifice rules
// (src/scripts/sp/rules-pay.js), cross-checked against the offline engine's
// Card.checkPayment mirror and the bot's reference paymentFor.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stillOwed, costRows, checkPayment, autoPayment, paymentRoutes, canAfford, satchelBlocked,
    sacrificeInfo, reserveOutcome, reserveReturnOptions, buildReservePayload, buildBuyPayload,
} from "../../src/scripts/sp/rules-pay.js";
import { GEMS, amount, total } from "../../src/scripts/sp/rules-common.js";
import { playGame, paymentFor, mulberry32 } from "../e2e/lib/bot.mjs";
import { Engine, FakeApi, RuleError } from "../fixtures/engine.mjs";
import { findCards } from "../fixtures/cards.mjs";
import { game, player, card, tokens } from "../fixtures/states.mjs";

const TP = "BASE_ORIENT_TRADE_ROUTES";
const baseEngine = new Engine({ version: "BASE_ORIENT", players: ["a", "b"] });
const tpEngine = new Engine({ version: TP, players: ["a", "b"] });

/** The ActionResult names of the messages Engine.checkPayment raises. */
const CHECK_CODES = [
    ["The tokens chosen are invalid", "INVALID_TOKENS_GIVEN"],
    ["You do not have enough tokens", "NOT_ENOUGH_TOKENS_IN_INVENTORY"],
    ["You offered more than this card costs", "PAYMENT_TOO_HIGH"],
    ["The tokens offered, together with your bonuses, do not cover", "PAYMENT_TOO_LOW"],
    ["You do not have the bonuses this card requires", "NOT_ENOUGH_BONUSES"],
];

/** The engine's verdict on an offer, as the client's code names. */
const engineCheck = (c, p, offered) => {
    const e = p.goldTokenWorthTwoTokens ? tpEngine : baseEngine;
    try {
        return { code: "VALID_ACTION", ...e.checkPayment(c, p, offered) };
    } catch (err) {
        if (!(err instanceof RuleError)) throw err;
        const hit = CHECK_CODES.find(([prefix]) => err.message.startsWith(prefix));
        assert.ok(hit, `unexpected checkPayment message: ${err.message}`);
        return { code: hit[1] };
    }
};

/** Whether a refusal is the server's satchel prerequisite. */
const isSatchelRefusal = (text) => /^Cannot purchase card with satchel bonus/.test(text);

/** A Trading Posts player with gold worth 2. */
const goldTwo = (name, opts = {}) => player(name, { version: TP, powers: ["goldTokenWorthTwoTokens"], ...opts });

// ------------------------------------------------------------ breakdown

test("stillOwed and the breakdown rows subtract bonuses per colour", () => {
    const p = player("p", { cards: ["02", "08"], tokens: { Green: 1, Red: 2 } }); // Blue and Green bonuses
    assert.deepEqual(stillOwed(card("07"), p), { White: 0, Blue: 0, Green: 2, Red: 1, Brown: 0 });
    assert.deepEqual(costRows(card("07"), p), [
        { colour: "Blue", cost: 1, bonus: 1, owed: 0, have: 0, short: 0 },
        { colour: "Green", cost: 3, bonus: 1, owed: 2, have: 1, short: 1 },
        { colour: "Red", cost: 1, bonus: 0, owed: 1, have: 2, short: 0 },
    ]);
    assert.deepEqual(stillOwed(card("013"), p), { White: 0, Blue: 0, Green: 0, Red: 3, Brown: 0 });
    assert.deepEqual(costRows(card("072"), p).map((r) => [r.colour, r.owed]), [["White", 3], ["Green", 2], ["Red", 3], ["Brown", 5]]);
});

// ------------------------------------------------------------ the judge regressions

test("judge error 1: with gold worth 2, 1 Red + 1 Blue short and 1 gold token is not affordable", () => {
    // 07 costs Blue 1, Green 3, Red 1; three Green bonuses leave Blue 1 and Red 1
    const p = goldTwo("p", { tokens: { Gold: 1 }, bonuses: { Green: 3 } });
    assert.equal(canAfford(card("07"), p).level, "no");
    assert.equal(canAfford(card("07"), p).shortBy, 1);
    assert.equal(autoPayment(card("07"), p).ok, false);
    for (const offer of [{ Gold: 1 }, {}, { Gold: 1, Red: 0 }]) assert.equal(engineCheck(card("07"), p, offer).code, "PAYMENT_TOO_LOW");
    // the aggregate rounding the judges caught would have said yes: 2 gems, 1 gold worth 2
    const q = goldTwo("q", { tokens: { Gold: 2 }, bonuses: { Green: 3 } });
    assert.equal(canAfford(card("07"), q).level, "gold");
});

test("judge error 25: a satchel without a gem-bonus card is blocked", () => {
    const satchel = card("091"); // costs Blue 2, Red 3
    const p = player("p", { cards: ["096"], tokens: { Blue: 2, Red: 3 } });
    assert.equal(satchelBlocked(satchel, p), true);
    assert.equal(autoPayment(satchel, p).ok, false);
    assert.equal(autoPayment(satchel, p).code, "SATCHEL_NEEDS_GEM_CARD");
    assert.deepEqual(canAfford(satchel, p), { level: "no", shortBy: 0, reason: "satchel" });
    const q = player("q", { cards: ["01"], tokens: { Blue: 2, Red: 3 } });
    assert.equal(satchelBlocked(satchel, q), false);
    assert.equal(canAfford(satchel, q).level, "yes");
    // the engine refuses the purchase the same way
    const s = game({ players: [p, player("bob")] });
    const e = new Engine({ version: "BASE_ORIENT", players: ["p", "bob"] });
    e.state = structuredClone(s);
    const res = e.act("p", "BUY_CARD", buildBuyPayload("091", { Blue: 2, Red: 3 }));
    assert.equal(res.status, 400);
    assert.ok(isSatchelRefusal(res.text), res.text);
});

// ------------------------------------------------------------ gold

test("gold worth 2 with an odd deficit keeps one colour token", () => {
    const p = goldTwo("p", { tokens: { Red: 2, Gold: 1 } });
    const pay = autoPayment(card("013"), p); // Red 3
    assert.equal(pay.ok, true);
    assert.deepEqual(pay.tokens, { White: 0, Blue: 0, Green: 0, Red: 1, Brown: 0, Gold: 1 });
    assert.deepEqual(pay.keptByGold, ["Red"]);
    assert.equal(engineCheck(card("013"), p, pay.tokens).code, "VALID_ACTION");
    assert.equal(engineCheck(card("013"), p, { Red: 2, Gold: 1 }).code, "VALID_ACTION", "the wasteful payment is valid too");
    assert.equal(paymentFor(card("013"), p).tokens.Red, 2, "the bot's reference spends the extra Red");
    // an even deficit needs no adjustment
    const q = goldTwo("q", { tokens: { Red: 1, Gold: 1 } });
    assert.deepEqual(autoPayment(card("013"), q).keptByGold, []);
    assert.equal(autoPayment(card("013"), q).tokens.Red, 1);
});

test("gold tokens go first, a lone gold bonus is rounded up to the whole card, and the card route differs", () => {
    // 013 costs Red 3; 096 is a double-gold card (2 gold bonuses)
    const p = player("p", { cards: ["096"], tokens: { Gold: 2 } });
    const pay = autoPayment(card("013"), p);
    assert.equal(pay.ok, true);
    assert.equal(pay.goldTokens, 1, "1 token and both bonuses of the card instead of 2 tokens and half the card");
    assert.equal(pay.goldBonusesUsed, 2);
    assert.equal(pay.goldCardsDiscarded, 1);
    assert.equal(pay.goldBonusesWasted, 0);
    assert.equal(engineCheck(card("013"), p, pay.tokens).code, "VALID_ACTION");

    const rich = player("r", { cards: ["096"], tokens: { Gold: 3 } });
    const routes = paymentRoutes(card("013"), rich);
    assert.equal(routes.standard.tokens.Gold, 3);
    assert.equal(routes.standard.goldCardsDiscarded, 0);
    assert.equal(routes.goldCards.tokens.Gold, 1);
    assert.equal(routes.goldCards.goldCardsDiscarded, 1);
    assert.equal(routes.distinct, true, "both routes valid: offer the toggle");
    assert.equal(paymentRoutes(card("013"), p).distinct, false);
    for (const r of [routes.standard, routes.goldCards]) assert.equal(engineCheck(card("013"), rich, r.tokens).code, "VALID_ACTION");
});

test("a double-gold card used for 1 gold is discarded whole, and the waste is reported", () => {
    // 07 costs Blue 1, Green 3, Red 1; no Red token, so 1 gold is needed
    const p = player("p", { cards: ["096"], tokens: { Blue: 1, Green: 3 } });
    const pay = autoPayment(card("07"), p);
    assert.equal(pay.ok, true);
    assert.equal(pay.goldTokens, 0);
    assert.equal(pay.goldBonusesUsed, 1);
    assert.equal(pay.goldCardsDiscarded, 1);
    assert.equal(pay.goldBonusesWasted, 1);
    const check = checkPayment(card("07"), p, pay.tokens);
    assert.equal(check.goldBonusesToRemove, 2);
    assert.equal(check.goldCardsToDiscard, 1);
    const e = engineCheck(card("07"), p, pay.tokens);
    assert.equal(e.goldBonusesToRemove, 2);
    assert.equal(e.goldCardsToDiscard, 1);
});

// ------------------------------------------------------------ checkPayment

test("checkPayment refuses overpaying, underpaying, foreign tokens and tokens not held", () => {
    const p = player("p", { tokens: { Red: 4, Gold: 2, Blue: 1 } });
    const c = card("013"); // Red 3
    assert.equal(checkPayment(c, p, { Red: 3 }).ok, true);
    assert.equal(checkPayment(c, p, { Red: 3, Gold: 0, Blue: 0, Satchel: 0 }).ok, true, "zero keys are fine");
    assert.deepEqual([checkPayment(c, p, { Red: 4 }).code, checkPayment(c, p, { Red: 4 }).colour], ["PAYMENT_TOO_HIGH", "Red"]);
    assert.deepEqual([checkPayment(c, p, { Red: 3, Gold: 1 }).code, checkPayment(c, p, { Red: 3, Gold: 1 }).colour], ["PAYMENT_TOO_HIGH", "Gold"]);
    assert.equal(checkPayment(c, p, { Red: 2, Blue: 1 }).code, "PAYMENT_TOO_HIGH", "a colour the card does not cost");
    const low = checkPayment(c, p, { Red: 1 });
    assert.equal(low.code, "PAYMENT_TOO_LOW");
    assert.equal(low.shortBy, 2, "Still short 2");
    assert.equal(checkPayment(c, p, { Red: 2, Gold: 1 }).ok, true);
    assert.equal(checkPayment(c, p, { Red: -1 }).code, "INVALID_TOKENS_GIVEN");
    assert.equal(checkPayment(c, p, { Red: 3, Satchel: 1 }).code, "INVALID_TOKENS_GIVEN");
    assert.equal(checkPayment(c, p, { Red: 1.5 }).code, "INVALID_TOKENS_GIVEN");
    assert.equal(checkPayment(c, p, { Ruby: 1 }).code, "INVALID_TOKENS_GIVEN");
    assert.equal(checkPayment(c, p, { Red: 1, Gold: 3 }).code, "NOT_ENOUGH_TOKENS_IN_INVENTORY");
    for (const offer of [{ Red: 3 }, { Red: 4 }, { Red: 3, Gold: 1 }, { Red: 1 }, { Red: -1 }, { Red: 3, Satchel: 1 }, { Red: 1, Gold: 3 }]) {
        assert.equal(checkPayment(c, p, offer).code, engineCheck(c, p, offer).code, JSON.stringify(offer));
    }
});

// ------------------------------------------------------------ sacrifice

/** A player owning the given cards, with satchel ids assigned to Blue. */
const blueOwner = (ids, satchels = []) => {
    const p = player("p", { cards: ids });
    for (const id of satchels) {
        const s = card(id);
        s.tokenType = "Blue";
        p.devCards.push(s);
        p.bonuses.Blue += 1;
    }
    return p;
};

test("a sacrifice pays nothing and discards what the server would", () => {
    const sacrifice = card("111"); // Green, 3 points, costs 2 Blue bonuses
    const cases = [
        { p: blueOwner(["02", "042", "101"]), want: ["101"], lost: 0, why: "two 1-point singles lose more than a 0-point double" },
        { p: blueOwner(["07", "012", "101"]), want: ["07", "012"], lost: 0, why: "a tie keeps the double" },
        { p: blueOwner(["02", "101"], ["091"]), want: ["091", "02"], lost: 1, why: "an assigned satchel goes first" },
        { p: blueOwner(["052", "042"]), want: ["042", "052"], lost: 4, why: "two singles, fewest points first" },
        { p: blueOwner(["101"]), want: ["101"], lost: 0, why: "only a double" },
    ];
    for (const { p, want, lost, why } of cases) {
        const info = sacrificeInfo(sacrifice, p);
        assert.equal(info.ok, true, why);
        assert.equal(info.colour, "Blue");
        assert.equal(info.needed, 2);
        assert.deepEqual(info.cardIds, want, why);
        assert.equal(info.pointsLost, lost, why);
        const pay = autoPayment(sacrifice, p);
        assert.equal(pay.ok, true);
        assert.equal(pay.bonusCost, true);
        assert.equal(total(pay.tokens), 0, "zero tokens");
        assert.deepEqual(pay.sacrifice.cardIds, want);
        // the engine burns the same cards
        const clone = structuredClone(p);
        baseEngine.burn(clone, sacrifice.tokenCost);
        const gone = p.devCards.map((c) => c.id).filter((id) => !clone.devCards.some((c) => c.id === id));
        assert.deepEqual(gone.sort(), [...want].sort(), why);
    }
    const poor = blueOwner(["02"]);
    assert.equal(sacrificeInfo(sacrifice, poor).ok, false);
    assert.deepEqual(canAfford(sacrifice, poor), { level: "no", shortBy: 1, reason: "bonuses" });
    assert.equal(checkPayment(sacrifice, poor, {}).code, "NOT_ENOUGH_BONUSES");
    assert.equal(checkPayment(sacrifice, blueOwner(["101"]), { Gold: 0 }).ok, true);
    assert.equal(sacrificeInfo(card("01"), poor), null, "not a sacrifice");
    const tokensToo = blueOwner(["101"]);
    tokensToo.tokens.Blue = 1;
    assert.equal(checkPayment(sacrifice, tokensToo, { Blue: 1 }).code, "PAYMENT_TOO_HIGH");
});

// ------------------------------------------------------------ affordability

test("canAfford levels: yes with gems, gold with gold, no with what is short", () => {
    const c = card("013"); // Red 3
    assert.deepEqual(canAfford(c, player("p", { tokens: { Red: 3 } })), { level: "yes", shortBy: 0, reason: null });
    assert.deepEqual(canAfford(c, player("p", { tokens: { Red: 2, Gold: 1 } })), { level: "gold", shortBy: 0, reason: null });
    assert.deepEqual(canAfford(c, player("p", { cards: ["096"], tokens: { Red: 1 } })), { level: "gold", shortBy: 0, reason: null });
    assert.deepEqual(canAfford(c, player("p", { tokens: { Red: 1 } })), { level: "no", shortBy: 2, reason: "short" });
    assert.deepEqual(canAfford(c, player("p", { cards: ["09", "014", "019"] })), { level: "yes", shortBy: 0, reason: null }, "free with bonuses");
    assert.equal(canAfford(null, player("p")).level, "no");
});

// ------------------------------------------------------------ reserving

test("reserveOutcome: gain, an empty bank, needing a return, and every refusal", () => {
    const s = game();
    assert.deepEqual(reserveOutcome(s, "alice", "01"), { ok: true, reason: "", code: "OK", gold: "gain" });
    const empty = game({ bank: tokens({ Red: 4, Blue: 4, Green: 4, White: 4, Brown: 4, Gold: 0 }) });
    assert.equal(reserveOutcome(empty, "alice").gold, "bank-empty");
    const ten = game({ players: [player("alice", { tokens: { Red: 4, Blue: 3, Green: 3 } }), player("bob")] });
    assert.equal(reserveOutcome(ten, "alice").gold, "needs-return");
    assert.deepEqual(reserveReturnOptions(ten.players[0]), ["Blue", "Green", "Red", "Gold"]);
    assert.equal(reserveOutcome(s, "bob").reason, "Not your turn");
    assert.equal(reserveOutcome(s, "nobody").ok, false);
    const full = game({ players: [player("alice", { reserved: ["05", "06", "07"] }), player("bob")] });
    assert.deepEqual([reserveOutcome(full, "alice").ok, reserveOutcome(full, "alice").reason], [false, "You hold 3 reserved cards"]);
    const mine = game({ players: [player("alice", { reserved: ["05"] }), player("bob")] });
    assert.equal(reserveOutcome(mine, "alice", "05").code, "ALREADY_RESERVED");
    assert.equal(reserveOutcome(mine, "alice", "99999").code, "CARD_GONE");
    assert.equal(reserveOutcome(game({ actions: ["CASCADE_1"] }), "alice").ok, false);
    assert.equal(reserveOutcome({ ...s, gameOver: true }, "alice").code, "GAME_OVER");

    // the engine: at 10, returning Blue keeps 10 and takes the gold; skipping keeps 10 without it
    const e = new Engine({ version: "BASE_ORIENT", players: ["alice", "bob"] });
    e.state = structuredClone(ten);
    assert.equal(e.act("alice", "RESERVE_CARD", buildReservePayload("01", "Blue")).status, 200);
    assert.deepEqual([e.state.players[0].tokens.Gold, e.state.players[0].tokens.Blue, total(e.state.players[0].tokens)], [1, 2, 10]);
    e.state = structuredClone(ten);
    assert.equal(e.act("alice", "RESERVE_CARD", buildReservePayload("01", null)).status, 200);
    assert.deepEqual([e.state.players[0].tokens.Gold, total(e.state.players[0].tokens)], [0, 10]);
    assert.deepEqual(buildReservePayload("01"), { cardId: "01" });
    assert.deepEqual(buildReservePayload("01", "Satchel"), { cardId: "01" }, "never a Satchel put-back");
    e.state = structuredClone(s);
    assert.equal(e.act("alice", "RESERVE_CARD", buildReservePayload("01", "Gold")).status, 400, "no put-back below 10");
});

test("buildBuyPayload sends all six token keys", () => {
    assert.deepEqual(buildBuyPayload("013", { Red: 3 }), { cardId: "013", tokens: { White: 0, Blue: 0, Green: 0, Red: 3, Brown: 0, Gold: 0 } });
});

// ------------------------------------------------------------ fuzz: the mirror and exact feasibility

test("fuzz: checkPayment gives the engine's verdict for every offer, and autoPayment is ok exactly when some offer is", (t) => {
    const rnd = mulberry32(2026);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pool = findCards((c) => typeof c.cardTier === "string");
    const gemCard = card("01");
    let feasible = 0;
    let infeasible = 0;
    let offers = 0;
    let goldBonusUses = 0;
    for (let i = 0; i < 800; i++) {
        const c = pick(pool);
        const tp = rnd() < 0.4;
        const p = player("p", tp ? { version: TP, powers: rnd() < 0.7 ? ["goldTokenWorthTwoTokens"] : [] } : {});
        for (const g of GEMS) {
            p.tokens[g] = int(0, 3);
            p.bonuses[g] = int(0, 4);
        }
        p.tokens.Gold = int(0, 3);
        p.bonuses.Gold = pick([0, 0, 2, 4]);
        if (rnd() < 0.8) p.devCards.push(structuredClone(gemCard));
        const owed = stillOwed(c, p);
        const extra = pick(GEMS.filter((g) => !owed[g]).concat([GEMS[0]]));
        const colours = GEMS.filter((g) => owed[g] > 0 || g === extra);
        // every offer of 0..min(held, owed + 1) per colour and 0..held gold
        const ranges = colours.map((g) => Math.min(amount(p.tokens, g), owed[g] + 1));
        let anyValid = false;
        const walk = (k, offer) => {
            if (k === colours.length) {
                for (let gold = 0; gold <= p.tokens.Gold; gold++) {
                    const o = { ...offer, Gold: gold };
                    const mine = checkPayment(c, p, o);
                    const theirs = engineCheck(c, p, o);
                    offers++;
                    assert.equal(mine.code, theirs.code, `${c.id} ${JSON.stringify(o)} for ${JSON.stringify({ t: p.tokens, b: p.bonuses, tp })}`);
                    if (mine.ok) {
                        anyValid = true;
                        assert.equal(mine.goldBonusesToRemove, theirs.goldBonusesToRemove);
                        assert.equal(mine.goldCardsToDiscard, theirs.goldCardsToDiscard);
                        if (mine.goldBonusesUsed) goldBonusUses++;
                    }
                }
                return;
            }
            for (let n = 0; n <= ranges[k]; n++) walk(k + 1, { ...offer, [colours[k]]: n });
        };
        walk(0, {});
        const auto = autoPayment(c, p);
        const ref = paymentFor(c, p);
        assert.equal(auto.ok, anyValid && !satchelBlocked(c, p), `${c.id}: autoPayment ${auto.code}, some offer valid: ${anyValid}`);
        assert.equal(auto.ok, ref !== null, `${c.id}: autoPayment and the bot's paymentFor disagree`);
        assert.equal(autoPayment(c, p, { preferGoldCards: true }).ok, auto.ok);
        assert.equal(canAfford(c, p).level !== "no", auto.ok);
        if (auto.ok) {
            feasible++;
            assert.equal(engineCheck(c, p, auto.tokens).code, "VALID_ACTION");
            assert.ok(auto.spent <= (ref.bonusCost ? 0 : ref.spent), "never spends more tokens than the reference");
        } else {
            infeasible++;
            if (!satchelBlocked(c, p)) assert.ok(auto.shortBy > 0, `${c.id}: short by ${auto.shortBy}`);
        }
    }
    t.diagnostic(`fuzz: ${feasible} feasible, ${infeasible} not, ${offers} offers, ${goldBonusUses} valid offers with gold bonuses`);
    assert.ok(feasible > 50 && infeasible > 50, `${feasible} feasible, ${infeasible} not`);
    assert.ok(offers > 10000, `${offers} offers`);
    assert.ok(goldBonusUses > 20, `${goldBonusUses} valid offers used gold bonuses`);
});

// ------------------------------------------------------------ the engine cross-check

const VERSIONS = ["BASE_ORIENT", "BASE_ORIENT_CITIES", "BASE_ORIENT_CITIES_NOBLES", TP];
const MAIN = ["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"];

/**
 * Engine snapshots (state and hidden decks) at the start of main turns of
 * seeded bot games: `perVersion` per game version, spread evenly over one
 * 2-, 3- and 4-player game each.
 */
async function seededSnapshots(perVersion = 50) {
    const all = [];
    for (const version of VERSIONS) {
        const snaps = [];
        for (const [players, seed] of [[2, 21], [3, 22], [4, 23]]) {
            const api = new FakeApi({ seed });
            await playGame({
                api, players, version, seed,
                onStep: ({ sessionId, state }) => {
                    if (state.gameOver || !state.curValidActions.some((a) => MAIN.includes(a))) return;
                    const e = api.engine(sessionId);
                    snaps.push({ version, state: structuredClone(e.state), hidden: structuredClone(e.hidden) });
                },
            });
        }
        assert.ok(snaps.length >= perVersion, `${version}: only ${snaps.length} states`);
        for (let i = 0; i < perVersion; i++) all.push(snaps[Math.floor((i * snaps.length) / perVersion)]);
    }
    return all;
}

/** An Engine replayed to a snapshot. */
const engineAt = (snap) => {
    const e = new Engine({ version: snap.version, players: snap.state.players.map((p) => p.name) });
    e.state = structuredClone(snap.state);
    e.hidden = structuredClone(snap.hidden);
    return e;
};

const SNAPSHOTS = await seededSnapshots(50);

test("200 seeded states: autoPayment is ok exactly when paymentFor finds a payment, and the engine accepts it", (t) => {
    assert.equal(SNAPSHOTS.length, 200);
    const seen = { cards: 0, ok: 0, bought: 0, reservedBought: 0, gold: 0, goldTwo: 0, sacrifice: 0, satchelRefused: 0 };
    for (const snap of SNAPSHOTS) {
        const e = engineAt(snap);
        const saved = JSON.stringify(e.state);
        const savedHidden = JSON.stringify(e.hidden);
        const state = JSON.parse(saved);
        const market = ["tier1Deck", "tier2Deck", "tier3Deck", "tier1OrientDeck", "tier2OrientDeck", "tier3OrientDeck"]
            .flatMap((d) => state[d].visibleCards);
        state.players.forEach((p, seat) => {
            for (const c of [...market, ...p.reservedCards]) {
                seen.cards++;
                const auto = autoPayment(c, p);
                const viaCards = autoPayment(c, p, { preferGoldCards: true });
                const ref = paymentFor(c, p);
                assert.equal(auto.ok, ref !== null, `${snap.version} ${p.name} ${c.id}: autoPayment ${auto.code}, paymentFor ${JSON.stringify(ref)}`);
                assert.equal(viaCards.ok, auto.ok);
                assert.equal(canAfford(c, p).level !== "no", auto.ok);
                if (!auto.ok) {
                    if (seat === state.turnCounter && satchelBlocked(c, p)) {
                        const res = e.act(p.name, "BUY_CARD", buildBuyPayload(c.id, ref?.tokens ?? {}));
                        assert.equal(res.status, 400);
                        assert.ok(isSatchelRefusal(res.text), res.text);
                        seen.satchelRefused++;
                    }
                    continue;
                }
                seen.ok++;
                if (auto.goldTokens + auto.goldBonusesUsed > 0) seen.gold++;
                if (auto.goldValue === 2) seen.goldTwo++;
                for (const pay of [auto, viaCards]) {
                    assert.equal(engineCheck(c, p, pay.tokens).code, "VALID_ACTION", `${c.id} ${JSON.stringify(pay.tokens)}`);
                    assert.equal(checkPayment(c, p, pay.tokens).ok, true);
                }
                if (seat !== state.turnCounter) continue;
                // the current player really buys it through the engine
                const before = p.devCards.map((d) => d.id);
                const res = e.act(p.name, "BUY_CARD", buildBuyPayload(c.id, auto.tokens));
                assert.equal(res.status, 200, `${snap.version} ${p.name} buys ${c.id} with ${JSON.stringify(auto.tokens)}: ${res.text}`);
                seen.bought++;
                if (p.reservedCards.includes(c)) seen.reservedBought++;
                if (auto.bonusCost) {
                    const after = e.state.players[seat].devCards.map((d) => d.id);
                    const gone = before.filter((id) => !after.includes(id));
                    assert.deepEqual(gone.sort(), [...auto.sacrifice.cardIds].sort(), `${c.id}: the engine burned ${gone}`);
                    seen.sacrifice++;
                }
                e.state = JSON.parse(saved);
                e.hidden = JSON.parse(savedHidden);
            }
        });
    }
    t.diagnostic(`exercised: ${JSON.stringify(seen)}`);
    for (const [what, n] of Object.entries(seen)) {
        if (what === "sacrifice" || what === "satchelRefused") continue; // rare in bot games; covered by fixtures above
        assert.ok(n > 0, `no state exercised ${what}: ${JSON.stringify(seen)}`);
    }
});
