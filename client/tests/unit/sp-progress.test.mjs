// Unit tests for goal progress (src/scripts/sp/progress.js): nobles, cities
// and Trading Posts powers, checked against the offline engine's
// qualifiesForNoble, qualifiesCities and Trading Posts checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleProgress, cityProgress, powerProgress, powersProgress, POWERS } from "../../src/scripts/sp/progress.js";
import { GEMS } from "../../src/scripts/sp/rules-common.js";
import { playGame, mulberry32, qualifiesForCity } from "../e2e/lib/bot.mjs";
import { Engine, FakeApi } from "../fixtures/engine.mjs";
import { DECKS } from "../fixtures/cards.mjs";
import { player, card } from "../fixtures/states.mjs";

const TP = "BASE_ORIENT_TRADE_ROUTES";

test("noble badges: how many bonuses to go, or qualified", () => {
    const noble = card("20002"); // Blue 4, Green 4
    const p = player("p", { bonuses: { Blue: 4, Green: 1 } });
    const prog = nobleProgress(noble, p);
    assert.equal(prog.toGo, 3);
    assert.equal(prog.qualified, false);
    assert.deepEqual(prog.rows, [
        { colour: "Blue", need: 4, have: 4, short: 0 },
        { colour: "Green", need: 4, have: 1, short: 3 },
    ]);
    assert.deepEqual(prog.gap, { White: 0, Blue: 0, Green: 3, Red: 0, Brown: 0 });
    const done = nobleProgress(noble, player("q", { bonuses: { Blue: 5, Green: 4, Gold: 4 } }));
    assert.deepEqual([done.qualified, done.toGo], [true, 0]);
    assert.equal(nobleProgress(noble, player("r", { bonuses: { Gold: 8 } })).toGo, 8, "gold bonuses never count");
});

test("city progress: named colours, points and the same-colour requirement", () => {
    const named = cityProgress(card("40001"), player("p", { bonuses: { Red: 4, Brown: 1 }, prestigePoints: 11 })); // Red 4, Brown 3, 13 pts
    assert.deepEqual([named.qualified, named.toGo, named.pointsShort], [false, 2, 2]);
    const same = card("40008"); // 12 points, 6 of one colour
    const six = cityProgress(same, player("q", { bonuses: { Red: 6, Blue: 2 }, prestigePoints: 12 }));
    assert.deepEqual([six.qualified, six.same.colour, six.same.have, six.same.short], [true, "Red", 6, 0]);
    const gold = cityProgress(same, player("r", { bonuses: { Gold: 6 }, prestigePoints: 12 }));
    assert.deepEqual([gold.qualified, gold.same.colour, gold.same.short], [false, null, 6]);
    const both = card("40009"); // 14 points, Green 4 and 4 of another colour
    const greenOnly = cityProgress(both, player("s", { bonuses: { Green: 8 }, prestigePoints: 14 }));
    assert.equal(greenOnly.qualified, false, "the named colour does not double as the same colour");
    assert.equal(greenOnly.same.short, 4);
    assert.equal(cityProgress(both, player("t", { bonuses: { Green: 4, Blue: 4 }, prestigePoints: 14 })).qualified, true);
    assert.equal(cityProgress(card("40003"), player("u", { prestigePoints: 17 })).qualified, true, "points only");
});

test("power progress reads requirements from state and power 4 needs a noble", () => {
    const p = player("p", { version: TP, bonuses: { Green: 5 } });
    const four = powerProgress("addFivePrestigePoints", p);
    assert.deepEqual([four.met, four.toGo, four.needsNoble, four.hasNoble, four.unlocked], [false, 1, true, false, false]);
    p.nobleCards.push(card("20001"));
    assert.equal(powerProgress("addFivePrestigePoints", p).met, true);
    const custom = player("q", { version: TP });
    custom.extraTokenAfterPurchase.requirements = { Red: 1 };
    custom.bonuses.Red = 1;
    assert.equal(powerProgress("extraTokenAfterPurchase", custom).met, true, "the state's requirements win");
    const bare = { bonuses: { Blue: 3, Brown: 0 } };
    assert.deepEqual(powerProgress("goldTokenWorthTwoTokens", bare).requirements, { Blue: 3, Brown: 1 }, "defaults without state");
    assert.equal(powerProgress("goldTokenWorthTwoTokens", bare).toGo, 1);
    const unlocked = player("r", { version: TP, powers: ["extraTokenAfterTakingSameColor"] });
    assert.deepEqual([powerProgress("extraTokenAfterTakingSameColor", unlocked).unlocked, powerProgress("extraTokenAfterTakingSameColor", unlocked).met], [true, false],
        "unlocked stays unlocked even when the bonuses are gone");
    assert.deepEqual(powersProgress(p).map((x) => x.number), [1, 2, 3, 4, 5]);
    assert.deepEqual(POWERS.map((x) => x.key), ["extraTokenAfterPurchase", "extraTokenAfterTakingSameColor", "goldTokenWorthTwoTokens",
        "addFivePrestigePoints", "addPrestigePointsWithCoatsOfArms"]);
});

test("fuzz: noble and city progress agree with the engine for every noble and city", () => {
    const rnd = mulberry32(77);
    const e = new Engine({ version: "BASE_ORIENT_CITIES_NOBLES", players: ["a", "b"] });
    e.state.nobleDeck.visibleCards = structuredClone(DECKS.nobleDeck);
    e.state.citiesDeck.visibleCards = structuredClone(DECKS.citiesDeck);
    let nobles = 0;
    let cities = 0;
    for (let i = 0; i < 3000; i++) {
        const p = player("a", { version: "BASE_ORIENT_CITIES" });
        for (const g of GEMS) p.bonuses[g] = Math.floor(rnd() * 8);
        p.bonuses.Gold = Math.floor(rnd() * 3) * 2;
        p.prestigePoints = Math.floor(rnd() * 20);
        const nobleIds = e.qualifiesForNoble(p).map((n) => n.id);
        for (const n of DECKS.nobleDeck) {
            assert.equal(nobleProgress(n, p).qualified, nobleIds.includes(n.id), `${n.id} for ${JSON.stringify(p.bonuses)}`);
            if (nobleIds.includes(n.id)) nobles++;
        }
        const cityIds = e.qualifiesCities(structuredClone(p)).map((c) => c.id);
        for (const c of DECKS.citiesDeck) {
            const prog = cityProgress(c, p);
            assert.equal(prog.qualified, cityIds.includes(c.id), `${c.id} for ${JSON.stringify(p.bonuses)}, ${p.prestigePoints} pts`);
            assert.equal(prog.qualified, qualifiesForCity(p, c), "and with the e2e rules helper");
            assert.equal(prog.qualified, prog.toGo === 0 && prog.pointsShort === 0);
            if (prog.qualified) cities++;
        }
    }
    assert.ok(nobles > 100 && cities > 100, `${nobles} noble and ${cities} city qualifications seen`);
});

test("fuzz: a power is met exactly when the engine's end-of-turn check unlocks it", () => {
    const rnd = mulberry32(78);
    const e = new Engine({ version: TP, players: ["a", "b"] });
    let unlocks = 0;
    for (let i = 0; i < 3000; i++) {
        const p = player("a", { version: TP });
        for (const g of GEMS) p.bonuses[g] = Math.floor(rnd() * 6);
        if (rnd() < 0.5) p.nobleCards.push(card("20001"));
        const clone = structuredClone(p);
        e.tradingPostsChecks(clone);
        for (const { key } of POWERS) {
            assert.equal(powerProgress(key, p).met, clone[key].unlocked, `${key} for ${JSON.stringify(p.bonuses)}, ${p.nobleCards.length} nobles`);
            if (clone[key].unlocked) unlocks++;
        }
    }
    assert.ok(unlocks > 1000, `${unlocks} unlocks`);
});

const VERSIONS = ["BASE_ORIENT", "BASE_ORIENT_CITIES", "BASE_ORIENT_CITIES_NOBLES", TP];
const MAIN = ["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"];

/** States at the start of main turns of seeded bot games: `perVersion` per version, over 2-, 3- and 4-player games. */
async function seededStates(perVersion = 50) {
    const all = [];
    for (const version of VERSIONS) {
        const states = [];
        for (const [players, seed] of [[2, 21], [3, 22], [4, 23]]) {
            const api = new FakeApi({ seed });
            await playGame({
                api, players, version, seed,
                onStep: ({ state }) => {
                    if (!state.gameOver && state.curValidActions.some((a) => MAIN.includes(a))) states.push({ version, state });
                },
            });
        }
        for (let i = 0; i < perVersion; i++) all.push(states[Math.floor((i * states.length) / perVersion)]);
    }
    return all;
}

const STATES = await seededStates(50);

test("200 seeded states: progress agrees with Engine.qualifiesForNoble, qualifiesCities and the unlocked powers", (t) => {
    assert.equal(STATES.length, 200);
    const seen = { nobleChecks: 0, nobleQualified: 0, reservedNobles: 0, cityChecks: 0, cityQualified: 0, powersUnlocked: 0 };
    for (const { version, state } of STATES) {
        const e = new Engine({ version, players: state.players.map((p) => p.name) });
        e.state = structuredClone(state);
        for (const p of e.state.players) {
            // qualifiesForNoble looks at the board's nobles and the player's own reserved ones
            const ids = e.qualifiesForNoble(p).map((n) => n.id);
            for (const n of [...e.state.nobleDeck.visibleCards, ...p.reservedNobles]) {
                const prog = nobleProgress(n, p);
                assert.equal(prog.qualified, ids.includes(n.id), `${version} ${p.name} noble ${n.id}`);
                seen.nobleChecks++;
                if (prog.qualified) seen.nobleQualified++;
            }
            seen.reservedNobles += p.reservedNobles.length;
            if (e.cities) {
                const cityIds = e.qualifiesCities(structuredClone(p)).map((c) => c.id);
                for (const c of e.state.citiesDeck.visibleCards) {
                    const prog = cityProgress(c, p);
                    assert.equal(prog.qualified, cityIds.includes(c.id), `${version} ${p.name} city ${c.id}`);
                    seen.cityChecks++;
                    if (prog.qualified) seen.cityQualified++;
                }
            }
            if (e.tp) {
                for (const { key } of POWERS) {
                    const prog = powerProgress(key, p);
                    assert.equal(prog.unlocked, p[key].unlocked);
                    // bonuses only change during their owner's turn, whose end unlocks every power then met
                    if (prog.met) assert.equal(prog.unlocked, true, `${p.name} meets ${key} but it is still locked`);
                    if (prog.unlocked) seen.powersUnlocked++;
                }
            }
        }
    }
    t.diagnostic(`exercised: ${JSON.stringify(seen)}`);
    for (const what of ["nobleChecks", "cityChecks", "powersUnlocked"]) assert.ok(seen[what] > 0, `nothing exercised ${what}`);
});
