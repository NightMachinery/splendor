// @ts-check
/**
 * Goal progress for nobles, cities and Trading Posts powers (WP-RULES),
 * DOM-free. Mirrors OrientGame.qualifiesForNoble, CitiesGame.qualifiesCities
 * and the power classes under gameversions/tradingposts. All counts are
 * bonuses (cards owned), never tokens. See docs/ui/rules.md.
 */
import { GEMS, amount } from "./rules-common.js";

/**
 * @typedef {import("./rules-common.js").TokenMap} TokenMap
 * @typedef {{ colour: string, need: number, have: number, short: number }} ProgressRow
 */

/**
 * Per-colour rows for a bonus requirement, in display order, for colours it names.
 * @param {any} requirement @param {any} player
 */
const rowsFor = (requirement, player) => GEMS.filter((g) => amount(requirement, g) > 0).map((g) => {
    const need = amount(requirement, g);
    const have = amount(player?.bonuses, g);
    return { colour: g, need, have, short: Math.max(0, need - have) };
});

/** @param {ProgressRow[]} rows */
const gapOf = (rows) => {
    /** @type {TokenMap} */
    const gap = {};
    for (const g of GEMS) gap[g] = 0;
    for (const r of rows) gap[r.colour] = r.short;
    return gap;
};

/**
 * How far a player is from a noble: the bonuses still missing per colour
 * (`gap`), their sum (`toGo`, the tile badge "3 to go") and whether the
 * noble would visit now (`qualified`). Whether it may visit this turn also
 * depends on nobleVisitedThisTurn, which this does not look at.
 * @param {any} noble @param {any} player
 * @returns {{ qualified: boolean, toGo: number, gap: TokenMap, rows: ProgressRow[] }}
 */
export function nobleProgress(noble, player) {
    const rows = rowsFor(noble?.tokenCost, player);
    const toGo = rows.reduce((s, r) => s + r.short, 0);
    return { qualified: toGo === 0, toGo, gap: gapOf(rows), rows };
}

/**
 * How far a player is from a city (CitiesGame.qualifiesCities): the named
 * colours (`rows`, `gap`), the prestige (`pointsShort`) and the "same
 * colour" requirement (`same`): numSameBonuses bonuses of one gem colour the
 * city does not name; the best such colour so far is `same.colour` (null
 * when the player has none). `toGo` counts bonuses still missing, named and
 * same-colour together; points are separate.
 * @param {any} city @param {any} player
 * @returns {{
 *   qualified: boolean, toGo: number, gap: TokenMap, rows: ProgressRow[],
 *   points: number, pointsNeeded: number, pointsShort: number,
 *   same: { count: number, colour: string | null, have: number, short: number },
 * }}
 */
export function cityProgress(city, player) {
    const rows = rowsFor(city?.tokenCost, player);
    let colour = null;
    let have = 0;
    for (const g of GEMS) {
        if (amount(city?.tokenCost, g) > 0) continue;
        const b = amount(player?.bonuses, g);
        if (b > have) {
            have = b;
            colour = g;
        }
    }
    const count = amount(city, "numSameBonuses");
    const same = { count, colour, have, short: Math.max(0, count - have) };
    const points = amount(player, "prestigePoints");
    const pointsNeeded = amount(city, "prestigePoints");
    const pointsShort = Math.max(0, pointsNeeded - points);
    const named = rows.reduce((s, r) => s + r.short, 0);
    return {
        qualified: named === 0 && same.short === 0 && pointsShort === 0,
        toGo: named + same.short,
        gap: gapOf(rows),
        rows,
        points, pointsNeeded, pointsShort,
        same,
    };
}

/**
 * The five Trading Posts powers, in order, with the bonus requirements the
 * server uses when the state does not carry them. Power 4 also needs a noble.
 */
/** @type {Array<{ key: string, number: number, requirements: TokenMap, needsNoble: boolean }>} */
const POWER_LIST = [
    { key: "extraTokenAfterPurchase", number: 1, requirements: { Red: 3, White: 1 }, needsNoble: false },
    { key: "extraTokenAfterTakingSameColor", number: 2, requirements: { White: 2 }, needsNoble: false },
    { key: "goldTokenWorthTwoTokens", number: 3, requirements: { Blue: 3, Brown: 1 }, needsNoble: false },
    { key: "addFivePrestigePoints", number: 4, requirements: { Green: 5 }, needsNoble: true },
    { key: "addPrestigePointsWithCoatsOfArms", number: 5, requirements: { Brown: 3 }, needsNoble: false },
];
export const POWERS = Object.freeze(POWER_LIST.map((p) => Object.freeze({ ...p, requirements: Object.freeze({ ...p.requirements }) })));

/**
 * How far a player is from a Trading Posts power. Requirements come from the
 * player's state (`player[key].requirements`) when present, else POWERS.
 * `met` means the condition holds now; the server unlocks a power at the end
 * of the turn in which it is met, and an unlocked power stays unlocked even
 * if a sacrifice later lowers the bonuses. `toGo` counts missing bonuses
 * (plus 1 for the missing noble of power 4).
 * @param {string} key one of POWERS[].key
 * @param {any} player
 * @returns {{
 *   key: string, number: number, unlocked: boolean, met: boolean, toGo: number,
 *   gap: TokenMap, rows: ProgressRow[], requirements: TokenMap, needsNoble: boolean, hasNoble: boolean,
 * }}
 */
export function powerProgress(key, player) {
    const def = POWERS.find((p) => p.key === key);
    const own = player?.[key];
    const fromState = own && typeof own.requirements === "object" && own.requirements ? own.requirements : null;
    /** @type {TokenMap} */
    const requirements = {};
    for (const g of GEMS) {
        const n = amount(fromState ?? def?.requirements, g);
        if (n > 0) requirements[g] = n;
    }
    const rows = rowsFor(requirements, player);
    const needsNoble = def?.needsNoble ?? false;
    const hasNoble = (player?.nobleCards || []).length > 0;
    const missing = rows.reduce((s, r) => s + r.short, 0) + (needsNoble && !hasNoble ? 1 : 0);
    return {
        key,
        number: def?.number ?? 0,
        unlocked: own?.unlocked === true,
        met: missing === 0,
        toGo: missing,
        gap: gapOf(rows),
        rows,
        requirements,
        needsNoble,
        hasNoble,
    };
}

/**
 * powerProgress for all five powers, in order.
 * @param {any} player
 */
export const powersProgress = (player) => POWERS.map((p) => powerProgress(p.key, player));
