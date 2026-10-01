// Unit tests for the gem-taking rules (src/scripts/sp/rules-take.js), with a
// cross-check against the offline engine over 200 states of seeded games.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    pickTransition, takeHint, isLegalTake, excessAfter, validReturn, returnTransition,
    buildTakePayload, buildPassPayload, legalTakeExists, legalMoveExists, requiredSingles,
} from "../../src/scripts/sp/rules-take.js";
import { GEMS, TOKEN_KEYS, total, amount, hasDoublePlusOne } from "../../src/scripts/sp/rules-common.js";
import { playGame } from "../e2e/lib/bot.mjs";
import { Engine, FakeApi, RuleError } from "../fixtures/engine.mjs";
import { game, player, tokens } from "../fixtures/states.mjs";

const TP = "BASE_ORIENT_TRADE_ROUTES";

/** Apply taps in order and return the final transition. */
const tap = (state, who, colours, start = {}) => {
    let t = { picks: start };
    for (const c of colours) t = pickTransition(state, who, t.picks, c);
    return t;
};

// ------------------------------------------------------------ the tap rules

test("three different colours make a take of three singles", () => {
    const s = game();
    const t = tap(s, "alice", ["Red", "Blue", "Green"]);
    assert.deepEqual(t.picks, { Red: 1, Blue: 1, Green: 1 });
    assert.ok(isLegalTake(s, "alice", t.picks));
    assert.deepEqual(buildTakePayload(t.picks, {}), {
        takeTokens: { White: 0, Blue: 1, Green: 1, Red: 1, Brown: 0, Gold: 0 },
        putBackTokens: { White: 0, Blue: 0, Green: 0, Red: 0, Brown: 0, Gold: 0 },
    });
});

test("tapping a lone colour again takes 2 from a pile of 4", () => {
    const s = game(); // 2 players: 4 of each gem
    const t = tap(s, "alice", ["Red", "Red"]);
    assert.deepEqual(t.picks, { Red: 2 });
    assert.equal(t.code, "double");
    assert.ok(isLegalTake(s, "alice", t.picks));
    assert.equal(buildTakePayload(t.picks).takeTokens.Red, 2);
});

test("tapping a lone colour again on a pile of 3 shakes, says why and removes it", () => {
    const s = game({ bank: tokens({ Red: 3, Blue: 4, Green: 4, White: 4, Brown: 4, Gold: 5 }) });
    const t = tap(s, "alice", ["Red", "Red"]);
    assert.equal(t.shake, true);
    assert.equal(t.code, "double-needs-4");
    assert.match(t.hint, /needs a pile of 4/);
    assert.deepEqual(t.picks, {});
    assert.equal(isLegalTake(s, "alice", { Red: 2 }), false);
});

test("a fourth colour is rejected and a double is a whole turn", () => {
    const s = game();
    const four = tap(s, "alice", ["Red", "Blue", "Green", "White"]);
    assert.deepEqual(four.picks, { Red: 1, Blue: 1, Green: 1 });
    assert.equal(four.shake, true);
    assert.equal(four.hint, "Max 3 different colours");
    const dbl = tap(s, "alice", ["Red", "Red", "Blue"]);
    assert.deepEqual(dbl.picks, { Red: 2 });
    assert.equal(dbl.hint, "2 of one colour is a whole turn");
    assert.equal(isLegalTake(s, "alice", { Red: 2, Blue: 1 }), false);
});

test("a picked colour is removed by another tap", () => {
    const s = game();
    assert.deepEqual(tap(s, "alice", ["Red", "Blue", "Red"]).picks, { Blue: 1 });
    assert.deepEqual(tap(s, "alice", ["Red", "Red", "Red"]).picks, {});
    assert.equal(tap(s, "alice", ["Red", "Blue", "Red"]).shake, false);
});

test("with Trading Posts power 2 a double plus one single is allowed, and no more", () => {
    const alice = player("alice", { version: TP, powers: ["extraTokenAfterTakingSameColor"] });
    const s = game({ version: TP, players: [alice, player("bob", { version: TP })] });
    const t = tap(s, "alice", ["Red", "Red", "Blue"]);
    assert.deepEqual(t.picks, { Red: 2, Blue: 1 });
    assert.ok(isLegalTake(s, "alice", t.picks));
    const more = pickTransition(s, "alice", t.picks, "Green");
    assert.equal(more.shake, true);
    assert.equal(more.hint, "With 2 of a colour you may add 1 more");
    assert.equal(takeHint(s, "alice", { Red: 2 }), "You may add 1 more colour");
    // the same take without the power
    const plain = game({ version: TP });
    assert.equal(isLegalTake(plain, "alice", { Red: 2, Blue: 1 }), false);
});

test("Gold and empty piles are never pickable", () => {
    const s = game({ bank: tokens({ Red: 0, Blue: 4, Green: 4, White: 4, Brown: 4, Gold: 5 }) });
    const gold = pickTransition(s, "alice", {}, "Gold");
    assert.equal(gold.changed, false);
    assert.equal(gold.hint, "Gold comes only from reserving a card");
    assert.equal(isLegalTake(s, "alice", { Gold: 1, Red: 1, Blue: 1 }), false);
    const empty = pickTransition(s, "alice", {}, "Red");
    assert.equal(empty.changed, false);
    assert.equal(isLegalTake(s, "alice", { Red: 1, Blue: 1, Green: 1 }), false);
    assert.equal(isLegalTake(s, "alice", { Satchel: 1, Blue: 1, Green: 1 }), false);
    assert.equal(isLegalTake(s, "alice", { Blue: 1, Green: 1, White: 1, Gold: 0, Satchel: 0 }), true);
});

test("singles must number min(3, colours in the bank)", () => {
    const s = game();
    assert.equal(requiredSingles(s), 3);
    assert.equal(isLegalTake(s, "alice", { Red: 1, Blue: 1 }), false, "the server allows it, the client does not");
    const two = game({ bank: tokens({ Red: 1, Blue: 2, Gold: 5 }) });
    assert.equal(requiredSingles(two), 2);
    assert.ok(isLegalTake(two, "alice", { Red: 1, Blue: 1 }));
    assert.equal(isLegalTake(two, "alice", { Red: 1 }), false);
    const one = game({ bank: tokens({ Red: 1, Gold: 5 }) });
    assert.ok(isLegalTake(one, "alice", { Red: 1 }));
    assert.equal(isLegalTake(s, "alice", {}), false, "an empty take is a pass, not a take");
    assert.equal(isLegalTake(s, "alice", { Red: 1.5 }), false);
    assert.equal(isLegalTake(s, "alice", { Red: -1, Blue: 1, Green: 1, White: 1 }), false);
});

test("live hints", () => {
    const s = game();
    assert.equal(takeHint(s, "alice", {}), "");
    assert.equal(takeHint(s, "alice", { Red: 1 }), "Tap Red again to take 2");
    assert.equal(takeHint(s, "alice", { Red: 1, Blue: 1 }), "Pick 1 more colour");
    assert.equal(takeHint(s, "alice", { Red: 1, Blue: 1, Green: 1 }), "");
    assert.equal(takeHint(s, "alice", { Red: 2 }), "");
    const low = game({ bank: tokens({ Red: 3, Blue: 3, Green: 3, White: 3, Brown: 3, Gold: 5 }) });
    assert.equal(takeHint(low, "alice", { Red: 1 }), "Pick 2 more colours");
});

// ------------------------------------------------------------ returns

test("at 9 held, taking 3 needs exactly 2 back, and just-taken gems and Gold may go back", () => {
    const alice = player("alice", { tokens: { Red: 2, Blue: 2, Green: 2, White: 1, Gold: 2 } });
    const s = game({ players: [alice, player("bob")] });
    const take = { Brown: 1, Red: 1, Blue: 1 };
    assert.ok(isLegalTake(s, "alice", take));
    assert.equal(excessAfter(alice, take), 2);
    assert.ok(validReturn(alice, take, { Brown: 1, Gold: 1 }), "a just-taken colour and Gold");
    assert.ok(validReturn(alice, take, { Red: 2 }));
    assert.equal(validReturn(alice, take, { Brown: 2 }), false, "only 1 Brown held after the take");
    assert.equal(validReturn(alice, take, { Red: 1 }), false, "must land exactly on 10");
    assert.equal(validReturn(alice, take, { Red: 3 }), false, "must not go below 10");
    assert.equal(validReturn(alice, take, {}), false);
    assert.equal(validReturn(alice, {}, {}), true, "no excess, nothing to return");
    assert.equal(validReturn(alice, take, { Satchel: 1, Red: 1 }), false);
    const body = buildTakePayload(take, { Brown: 1, Gold: 1 });
    assert.deepEqual(body.putBackTokens, { White: 0, Blue: 0, Green: 0, Red: 0, Brown: 1, Gold: 1 });
    // the engine agrees
    const e = new Engine({ version: "BASE_ORIENT", players: ["alice", "bob"] });
    e.state = structuredClone(s);
    assert.equal(e.act("alice", "TAKE_TOKEN", body).status, 200);
    assert.equal(total(e.state.players[0].tokens), 10);
});

test("tapping holdings while returning adds, caps, clears and refuses extra returns", () => {
    const alice = player("alice", { tokens: { Red: 2, Blue: 2, Green: 2, White: 1, Gold: 2 } });
    const take = { Brown: 1, Red: 1, Blue: 1 }; // excess 2
    let t = returnTransition(alice, take, {}, "Brown");
    assert.deepEqual(t.returns, { Brown: 1 });
    assert.equal(t.remaining, 1);
    t = returnTransition(alice, take, t.returns, "Brown"); // Brown is capped at 1 (just taken)
    assert.deepEqual(t.returns, {}, "a colour at its cap clears");
    t = returnTransition(alice, take, {}, "Red");
    t = returnTransition(alice, take, t.returns, "Red");
    assert.deepEqual(t.returns, { Red: 2 });
    assert.equal(t.remaining, 0);
    const refused = returnTransition(alice, take, t.returns, "Gold");
    assert.equal(refused.changed, false);
    assert.equal(refused.shake, true);
    assert.deepEqual(returnTransition(alice, take, t.returns, "Red").returns, {}, "Red reached the excess, so it clears");
    const mixed = returnTransition(alice, take, { Red: 1, Gold: 1 }, "Red");
    assert.deepEqual(mixed.returns, { Gold: 1 }, "tapping a returned colour when full clears it");
    assert.equal(returnTransition(alice, take, {}, "Satchel").changed, false);
    assert.equal(returnTransition(player("x"), { Red: 1 }, {}, "Red").code, "no-excess");
    assert.equal(returnTransition(alice, take, {}, "Brown").changed, true);
    assert.equal(returnTransition(player("y", { tokens: { Red: 9 } }), { Blue: 1, Green: 1, White: 1 }, {}, "Brown").code, "none-held");
});

// ------------------------------------------------------------ pass

test("Pass shows only when no move exists, and sends empty maps", () => {
    assert.ok(legalMoveExists(game(), "alice"));
    // no gems in the bank, 3 reserved cards and nothing affordable
    const stuck = player("alice", { reserved: ["071", "072", "073"] });
    const s = game({
        players: [stuck, player("bob")],
        board: { tier3Deck: ["074", "075", "076", "077"] },
        bank: tokens({ Gold: 0 }),
    });
    assert.equal(legalTakeExists(s), false);
    assert.equal(legalMoveExists(s, "alice"), false);
    assert.deepEqual(buildPassPayload(), { takeTokens: {}, putBackTokens: {} });
    const e = new Engine({ version: "BASE_ORIENT", players: ["alice", "bob"] });
    e.state = structuredClone(s);
    assert.equal(e.act("alice", "TAKE_TOKEN", buildPassPayload()).status, 200, "the engine accepts the pass");
    // a single affordable card, a free reserve slot or one gem in the bank each make a move
    const rich = structuredClone(s);
    rich.players[0].tokens = tokens({ Gold: 5 });
    rich.players[0].bonuses = tokens({ White: 7, Blue: 7, Green: 7, Red: 7, Brown: 7 });
    assert.ok(legalMoveExists(rich, "alice"), "an affordable reserved card");
    const slot = structuredClone(s);
    slot.players[0].reservedCards.pop();
    assert.ok(legalMoveExists(slot, "alice"), "a reserve");
    const gem = structuredClone(s);
    gem.tokens.Red = 1;
    assert.ok(legalMoveExists(gem, "alice"), "a take");
    assert.equal(legalMoveExists(s, "nobody"), false);
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

/** Every take map of 0 to 2 of each gem, except the empty one. */
const ALL_TAKES = (() => {
    const out = [];
    for (let code = 1; code < 3 ** GEMS.length; code++) {
        const take = {};
        let c = code;
        for (const g of GEMS) {
            const n = c % 3;
            c = Math.floor(c / 3);
            if (n) take[g] = n;
        }
        out.push(take);
    }
    return out;
})();

/** Every return of exactly `count` tokens, each colour at most held + taken. */
function returnsOf(me, take, count) {
    const keys = TOKEN_KEYS;
    const caps = keys.map((k) => amount(me.tokens, k) + amount(take, k));
    const out = [];
    const walk = (i, left, acc) => {
        if (i === keys.length) {
            if (left === 0) out.push({ ...acc });
            return;
        }
        for (let n = 0; n <= Math.min(left, caps[i]); n++) {
            if (n) acc[keys[i]] = n;
            else delete acc[keys[i]];
            walk(i + 1, left - n, acc);
        }
        delete acc[keys[i]];
    };
    walk(0, count, {});
    return out;
}

/** One return of exactly `count` tokens within the caps (the first colours first). */
function firstReturn(me, take, count) {
    const back = {};
    let left = count;
    for (const k of TOKEN_KEYS) {
        const n = Math.min(left, amount(me.tokens, k) + amount(take, k));
        if (n) back[k] = n;
        left -= n;
    }
    return left === 0 ? back : null;
}

/** Whether a take meets the client's strict singles rule (a singles-only take takes min(3, colours available)). */
const strictSingles = (state, take) => {
    const vals = Object.values(take);
    return vals.includes(2) || vals.filter((v) => v === 1).length === requiredSingles(state);
};

/** Engine.apply without the snapshot and rollback of act: true when accepted (the caller restores). */
const accepts = (e, name, body) => {
    try {
        e.apply(name, "TAKE_TOKEN", body);
        return true;
    } catch (err) {
        if (err instanceof RuleError) return false;
        throw err;
    }
};

const SNAPSHOTS = await seededSnapshots(50);

/**
 * Bot games never empty the bank down to fewer than 3 colours, so every 10th
 * state is also checked with 2, 3 and 4 gem colours emptied (the one or two
 * left with a pile of 4): the strict singles rule then asks for 2 or 1.
 */
const DEPLETED = SNAPSHOTS.filter((_, i) => i % 10 === 0).flatMap((snap, i) => [2, 3, 4].map((empty) => {
    const copy = { ...snap, state: structuredClone(snap.state) };
    const order = [...GEMS.slice(i % 5), ...GEMS.slice(0, i % 5)];
    order.forEach((g, k) => { copy.state.tokens[g] = k < empty ? 0 : 4; });
    return copy;
}));
const CASES = [...SNAPSHOTS, ...DEPLETED];

test("200 seeded states (and 60 with emptied piles): every client-legal take with a valid return is accepted by the engine", (t) => {
    assert.equal(SNAPSHOTS.length, 200);
    assert.equal(DEPLETED.length, 60);
    const seen = { takes: 0, withReturn: 0, returnTakenColour: 0, returnGold: 0, doublePlusOne: 0, fewerColours: 0, invalidReturnsRefused: 0 };
    for (const snap of CASES) {
        const e = engineAt(snap);
        const saved = JSON.stringify(e.state);
        const state = JSON.parse(saved);
        const me = state.players[state.turnCounter];
        if (requiredSingles(state) < 3) seen.fewerColours++;
        for (const take of ALL_TAKES) {
            if (!isLegalTake(state, me, take)) continue;
            const excess = excessAfter(me, take);
            const returns = excess ? returnsOf(me, take, excess) : [{}];
            assert.ok(returns.length > 0);
            for (const back of returns) {
                assert.ok(validReturn(me, take, back), JSON.stringify({ take, back }));
                const res = e.act(me.name, "TAKE_TOKEN", buildTakePayload(take, back));
                assert.equal(res.status, 200, `${snap.version} ${me.name} take ${JSON.stringify(take)} back ${JSON.stringify(back)}: ${res.text}`);
                e.state = JSON.parse(saved);
                seen.takes++;
                if (excess) seen.withReturn++;
                if (Object.keys(back).some((k) => take[k])) seen.returnTakenColour++;
                if (back.Gold) seen.returnGold++;
                if (hasDoublePlusOne(me) && Object.keys(take).length === 2) seen.doublePlusOne++;
            }
            // returns the client calls invalid are refused by the engine too
            const wrong = excess ? [firstReturn(me, take, excess - 1), firstReturn(me, take, excess + 1)] : [{ [Object.keys(take)[0]]: 1 }];
            for (const back of wrong.filter(Boolean)) {
                assert.equal(validReturn(me, take, back), false);
                assert.equal(accepts(e, me.name, buildTakePayload(take, back)), false,
                    `the engine accepted the invalid return ${JSON.stringify(back)} for ${JSON.stringify(take)}`);
                seen.invalidReturnsRefused++;
            }
        }
        assert.equal(JSON.stringify(e.state), saved, "refusals left the engine unchanged");
    }
    t.diagnostic(`exercised: ${JSON.stringify(seen)}`);
    for (const [what, n] of Object.entries(seen)) assert.ok(n > 0, `no state exercised ${what}: ${JSON.stringify(seen)}`);
});

test("200 seeded states (and 60 with emptied piles): every engine-accepted take that meets the strict singles rule is client-legal", (t) => {
    let accepted = 0;
    let stricter = 0;
    for (const snap of CASES) {
        const e = engineAt(snap);
        const saved = JSON.stringify(e.state);
        const state = JSON.parse(saved);
        const me = state.players[state.turnCounter];
        for (const take of ALL_TAKES) {
            const excess = excessAfter(me, take);
            const back = excess ? firstReturn(me, take, excess) : {};
            // e.apply throws on a refusal before changing anything, so only an accepted take needs a restore
            const ok = accepts(e, me.name, buildTakePayload(take, back));
            if (ok) e.state = JSON.parse(saved);
            if (!ok) {
                assert.equal(isLegalTake(state, me, take) && validReturn(me, take, back), false,
                    `${snap.version}: the engine refused ${JSON.stringify(take)} that the client allows`);
                continue;
            }
            if (strictSingles(state, take)) {
                accepted++;
                assert.ok(isLegalTake(state, me, take), `${snap.version}: the engine accepted ${JSON.stringify(take)}, the client refuses it`);
                assert.ok(validReturn(me, take, back));
            } else {
                stricter++;
                assert.equal(isLegalTake(state, me, take), false, "fewer singles than required stay client-illegal");
            }
        }
        assert.equal(JSON.stringify(e.state), saved, "the sweep left the engine unchanged");
    }
    t.diagnostic(`${accepted} engine-accepted takes checked, ${stricter} accepted by the engine but refused by the stricter client`);
    assert.ok(accepted > 1000, `${accepted} accepted takes`);
    assert.ok(stricter > 0, "the server's 1- and 2-colour takes were seen");
});
