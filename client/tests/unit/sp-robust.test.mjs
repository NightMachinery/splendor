// Robustness sweep over every function the sp rule modules export: missing,
// null and malformed arguments must never throw (docs/ui/rules.md, "Missing
// fields"). A caller such as the card sheet may pass a value before the state
// or the settings have loaded, and a throw there would abort its render.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as common from "../../src/scripts/sp/rules-common.js";
import * as take from "../../src/scripts/sp/rules-take.js";
import * as pay from "../../src/scripts/sp/rules-pay.js";
import * as progress from "../../src/scripts/sp/progress.js";
import * as errors from "../../src/scripts/sp/errors.js";
import { game, player, card } from "../fixtures/states.mjs";

const MODULES = { "rules-common": common, "rules-take": take, "rules-pay": pay, progress, errors };

/** Odd values for each argument position: absent, null, empty, wrong types, half-built objects. */
const ODD = [
    undefined,
    null,
    {},
    [],
    "alice",
    0,
    { players: [null, {}], tokens: null, tier1Deck: { visibleCards: [null, {}] }, curValidActions: null },
    { tokenCost: null, costType: "Bonus", cardTier: "TIER_1" },
    { tokens: { Red: "3" }, bonuses: null, devCards: [null] },
];

test("no exported rule function throws on missing, null or malformed arguments", () => {
    const real = game({ players: [player("alice", { tokens: { Red: 2, Gold: 1 } }), player("bob")] });
    const values = [...ODD, real, real.players[0], card("013")];
    const thrown = [];
    let calls = 0;
    for (const [mod, exports] of Object.entries(MODULES)) {
        for (const [name, fn] of Object.entries(exports)) {
            if (typeof fn !== "function") continue;
            for (const a of values) {
                for (const b of values) {
                    for (const c of [undefined, null, {}, "Red"]) {
                        calls++;
                        try {
                            fn(a, b, c, "Red");
                        } catch (err) {
                            thrown.push(`${mod}.${name}: ${err.message}`);
                        }
                    }
                }
            }
        }
    }
    assert.ok(calls > 1000, `only ${calls} calls made; did the module exports change shape?`);
    assert.deepEqual([...new Set(thrown)], []);
});

test("autoPayment treats a null options argument like an omitted one", () => {
    const p = player("p", { tokens: { Red: 2, Gold: 1 } });
    const c = card("013"); // Red 3
    const omitted = pay.autoPayment(c, p);
    assert.equal(omitted.ok, true);
    assert.deepEqual(pay.autoPayment(c, p, null), omitted);
    assert.deepEqual(pay.autoPayment(c, p, undefined), omitted);
    assert.deepEqual(pay.autoPayment(c, p, {}), omitted);
});
