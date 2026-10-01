// @ts-check
/**
 * Gem-taking rules for the gem rail (WP-RULES), DOM-free.
 *
 * Mirrors TakeTokenAction on the server, with one deliberate restriction: a
 * take of single gems must take min(3, colours the bank still has), never
 * fewer (the server also accepts 1 or 2 singles). See docs/ui/rules.md.
 *
 * "Picks" are the gems the player has tapped so far, as a token map of gem
 * colours to 1 or 2. "Returns" are the tokens they hand back to end on
 * exactly 10, as a token map that may include Gold.
 */
import {
    GEMS, TOKEN_KEYS, MAX_TOKENS, MAX_RESERVED, MAIN_ACTIONS,
    amount, total, isGem, hasDoublePlusOne, resolvePlayer, marketCards, fullTokenMap,
} from "./rules-common.js";
import { autoPayment } from "./rules-pay.js";

/** Every key a server token map may carry. */
const TOKEN_TYPES = [...TOKEN_KEYS, "Satchel"];

/**
 * @typedef {import("./rules-common.js").TokenMap} TokenMap
 *
 * @typedef {{
 *   picks: TokenMap,
 *   changed: boolean,
 *   shake: boolean,
 *   code: string,
 *   hint: string,
 * }} Transition
 */

/**
 * Gem colours the bank still has at least one of.
 * @param {any} state
 */
export const availableColours = (state) => GEMS.filter((g) => amount(state?.tokens, g) >= 1);

/**
 * How many single gems a singles-only take must have: min(3, colours available).
 * @param {any} state
 */
export const requiredSingles = (state) => Math.min(3, availableColours(state).length);

/**
 * Gems-only copy of a pick map, without zero or invalid entries.
 * @param {any} picks
 */
const cleanPicks = (picks) => {
    /** @type {TokenMap} */
    const out = {};
    for (const g of GEMS) {
        const n = amount(picks, g);
        if (n > 0) out[g] = n;
    }
    return out;
};

/**
 * The singles and doubles of a pick map.
 * @param {TokenMap} picks
 */
const shapeOf = (picks) => ({
    singles: GEMS.filter((g) => picks[g] === 1),
    doubles: GEMS.filter((g) => picks[g] === 2),
});

/**
 * What a tap on a bank pile does (section 5.3 of the design):
 *   - an unpicked colour is added as a single when no double is picked and
 *     fewer than 3 singles are; with Trading Posts power 2 it is also added
 *     as the one single next to a double; otherwise the tap is rejected;
 *   - a colour picked once becomes a double when it is the only pick and its
 *     bank pile holds at least 4; otherwise the tap removes it (when it was
 *     the only pick, with a shake and the hint that 2 need a pile of 4);
 *   - a colour picked twice is removed.
 * Gold and empty piles are never pickable. A rejected tap returns the picks
 * unchanged with `shake` set and a hint for the player.
 * @param {any} state @param {any} player @param {any} picks @param {string} colour
 * @returns {Transition}
 */
export function pickTransition(state, player, picks, colour) {
    const p = resolvePlayer(state, player);
    const cur = cleanPicks(picks);
    /** @param {string} code @param {string} hint */
    const reject = (code, hint) => ({ picks: cur, changed: false, shake: true, code, hint });
    /** @param {TokenMap} next @param {string} code @param {string} [hint] @param {boolean} [shake] */
    const done = (next, code, hint = "", shake = false) => ({ picks: next, changed: true, shake, code, hint });

    if (colour === "Gold") return reject("gold", "Gold comes only from reserving a card");
    if (!isGem(colour)) return reject("unknown", "");
    const n = amount(cur, colour);
    const { singles, doubles } = shapeOf(cur);

    if (n === 0) {
        if (amount(state?.tokens, colour) < 1) return reject("empty", `No ${colour} left in the bank`);
        if (doubles.length === 0) {
            if (singles.length < 3) return done({ ...cur, [colour]: 1 }, "add");
            return reject("max-colours", "Max 3 different colours");
        }
        if (!hasDoublePlusOne(p)) return reject("double-is-turn", "2 of one colour is a whole turn");
        if (singles.length === 0) return done({ ...cur, [colour]: 1 }, "add");
        return reject("double-plus-one", "With 2 of a colour you may add 1 more");
    }
    const without = { ...cur };
    delete without[colour];
    if (n === 1) {
        const onlyPick = singles.length === 1 && doubles.length === 0;
        if (onlyPick && amount(state?.tokens, colour) >= 4) return done({ ...cur, [colour]: 2 }, "double");
        if (onlyPick) return done(without, "double-needs-4", `Taking 2 ${colour} needs a pile of 4`, true);
        return done(without, "remove");
    }
    return done(without, "remove");
}

/**
 * The live hint under the gem rail for the current picks: "Tap Red again to
 * take 2" when a lone single's pile holds at least 4, "Pick 2 more colours"
 * or "Pick 1 more colour" while singles are missing, "You may add 1 more
 * colour" for a double with Trading Posts power 2, otherwise "".
 * @param {any} state @param {any} player @param {any} picks
 */
export function takeHint(state, player, picks) {
    const cur = cleanPicks(picks);
    const { singles, doubles } = shapeOf(cur);
    if (doubles.length === 1) {
        const p = resolvePlayer(state, player);
        const more = availableColours(state).some((g) => g !== doubles[0]);
        return hasDoublePlusOne(p) && singles.length === 0 && more ? "You may add 1 more colour" : "";
    }
    if (singles.length === 0 || doubles.length > 1) return "";
    if (singles.length === 1 && amount(state?.tokens, singles[0]) >= 4) return `Tap ${singles[0]} again to take 2`;
    const need = requiredSingles(state) - singles.length;
    if (need <= 0) return "";
    return need === 1 ? "Pick 1 more colour" : `Pick ${need} more colours`;
}

/**
 * Whether a take is legal for the client: only gem colours, whole amounts of
 * 0 to 2 that the bank holds, and one of
 *   - min(3, colours available) distinct singles and no double;
 *   - one double from a pile of at least 4;
 *   - with Trading Posts power 2, one double plus one single.
 * An empty take is not a take (Pass is separate, see legalMoveExists).
 * @param {any} state @param {any} player @param {any} take
 */
export function isLegalTake(state, player, take) {
    if (!take || typeof take !== "object") return false;
    for (const [t, a] of Object.entries(take)) {
        if (!TOKEN_TYPES.includes(t)) return false;
        if (typeof a !== "number" || !Number.isInteger(a) || a < 0 || a > 2) return false;
        if (!isGem(t) && a > 0) return false;
        if (a > amount(state?.tokens, t)) return false;
        if (a === 2 && amount(state?.tokens, t) < 4) return false;
    }
    const { singles, doubles } = shapeOf(cleanPicks(take));
    if (doubles.length === 0) return singles.length >= 1 && singles.length === requiredSingles(state);
    if (doubles.length > 1) return false;
    if (singles.length === 0) return true;
    return singles.length === 1 && hasDoublePlusOne(resolvePlayer(state, player));
}

/**
 * Tokens over 10 after a take: max(0, held + taken − 10).
 * @param {any} player @param {any} take
 */
export const excessAfter = (player, take) => Math.max(0, total(player?.tokens) + total(take) - MAX_TOKENS);

/**
 * Whether `returns` is a valid put-back for `take`: whole, non-negative
 * amounts of gems or Gold, each at most held + taken of that colour (gems
 * just taken may go back), and totalling exactly the excess, so the player
 * ends on exactly 10. With no excess, only an empty return is valid.
 * @param {any} player @param {any} take @param {any} returns
 */
export function validReturn(player, take, returns) {
    const back = returns && typeof returns === "object" ? returns : {};
    for (const [t, a] of Object.entries(back)) {
        if (typeof a !== "number" || !Number.isInteger(a) || a < 0) return false;
        if (a === 0) continue;
        if (!TOKEN_KEYS.includes(t)) return false;
        if (a > amount(player?.tokens, t) + amount(take, t)) return false;
    }
    return total(back) === excessAfter(player, take);
}

/**
 * What a tap on one of your holdings does while returning: it adds one
 * return of that colour, up to held + taken and up to the excess; a colour
 * at its cap is cleared instead. When the returns already make up the
 * excess, tapping a returned colour clears it and any other tap is rejected.
 * @param {any} player @param {any} take @param {any} returns @param {string} colour
 * @returns {{ returns: TokenMap, changed: boolean, shake: boolean, code: string, hint: string, remaining: number }}
 */
export function returnTransition(player, take, returns, colour) {
    const excess = excessAfter(player, take);
    /** @type {TokenMap} */
    const cur = {};
    for (const k of TOKEN_KEYS) if (amount(returns, k) > 0) cur[k] = amount(returns, k);
    /** @param {TokenMap} next @param {string} code */
    const done = (next, code) => ({ returns: next, changed: true, shake: false, code, hint: "", remaining: excess - total(next) });
    /** @param {string} code @param {string} hint */
    const reject = (code, hint) => ({ returns: cur, changed: false, shake: true, code, hint, remaining: excess - total(cur) });
    if (excess === 0) return reject("no-excess", "");
    if (!TOKEN_KEYS.includes(colour)) return reject("unknown", "");
    const cap = Math.min(amount(player?.tokens, colour) + amount(take, colour), excess);
    if (cap === 0) return reject("none-held", `You have no ${colour} to return`);
    const n = amount(cur, colour);
    const cleared = { ...cur };
    delete cleared[colour];
    if (n >= cap) return done(cleared, "clear");
    if (total(cur) >= excess) {
        if (n > 0) return done(cleared, "clear");
        return reject("enough", `Already returning ${excess}: tap a returned gem to undo`);
    }
    return done({ ...cur, [colour]: n + 1 }, "add");
}

/**
 * The TAKE_TOKEN body: every gem key and Gold (0) in takeTokens, every gem
 * key and Gold in putBackTokens. Satchel is never sent.
 * @param {any} take @param {any} [returns]
 */
export function buildTakePayload(take, returns) {
    const takeTokens = fullTokenMap(take);
    takeTokens.Gold = 0;
    return { takeTokens, putBackTokens: fullTokenMap(returns) };
}

/** The TAKE_TOKEN body of a pass: empty maps, which the server accepts as a turn with no take. */
export const buildPassPayload = () => ({ takeTokens: {}, putBackTokens: {} });

/**
 * Whether any legal take exists: some gem colour is in the bank. Any take is
 * possible then, whoever takes it, because tokens over 10 can always be
 * returned (even the ones just taken). Callers may pass the player as a
 * second argument; it does not change the answer.
 * @param {any} state
 */
export const legalTakeExists = (state) => availableColours(state).length > 0;

/**
 * Whether the player has any move other than a pass: a legal take, a card
 * on the market or in their reserve they can pay for, or a reserve (fewer
 * than 3 reserved and a card on the market). Only the main actions listed in
 * curValidActions count, so this is meaningful during the player's main
 * turn (phase mine). "No move possible · Pass" shows only when it is false.
 * @param {any} state @param {any} me a player name or object
 */
export function legalMoveExists(state, me) {
    const p = resolvePlayer(state, me);
    if (!state || !p) return false;
    const allowed = Array.isArray(state.curValidActions) ? state.curValidActions : MAIN_ACTIONS;
    if (allowed.includes("TAKE_TOKEN") && legalTakeExists(state)) return true;
    const market = marketCards(state).map(({ card }) => card);
    if (allowed.includes("BUY_CARD")) {
        for (const card of [...market, ...(p.reservedCards || [])]) if (autoPayment(card, p).ok) return true;
    }
    if (allowed.includes("RESERVE_CARD") && (p.reservedCards || []).length < MAX_RESERVED && market.length > 0) return true;
    return false;
}
