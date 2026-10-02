// @ts-check
/**
 * Payment, affordability, reserve and sacrifice rules (WP-RULES), DOM-free.
 *
 * checkPayment is a line-for-line mirror of the server's Card.checkPayment
 * (server/src/main/java/.../model/Card.java), which accepts exact payments
 * only. autoPayment builds the payment the card sheet fills in; every
 * payment it calls ok has passed checkPayment. See docs/ui/rules.md.
 */
import {
    GEMS, SERVER_GEM_ORDER, MAX_TOKENS, MAX_RESERVED,
    amount, total, isGem, goldValue, ownsGemBonusCard, fullTokenMap, resolvePlayer, currentPlayer, locateCard,
} from "./rules-common.js";

/**
 * @typedef {import("./rules-common.js").TokenMap} TokenMap
 *
 * @typedef {{
 *   ok: boolean,
 *   code: string,
 *   colour?: string,
 *   goldNeeded: number,
 *   goldOffered: number,
 *   goldBonusesUsed: number,
 *   goldBonusesToRemove: number,
 *   goldCardsToDiscard: number,
 *   goldBonusesWasted: number,
 *   shortBy: number,
 * }} PaymentCheck
 *
 * @typedef {{
 *   ok: boolean,
 *   code: string,
 *   tokens: TokenMap,
 *   bonusCost: boolean,
 *   goldValue: number,
 *   goldNeeded: number,
 *   goldTokens: number,
 *   goldBonusesUsed: number,
 *   goldCardsDiscarded: number,
 *   goldBonusesWasted: number,
 *   keptByGold: string[],
 *   shortBy: number,
 *   spent: number,
 *   sacrifice: SacrificeInfo | null,
 * }} AutoPayment
 *
 * @typedef {{
 *   ok: boolean,
 *   colour: string | null,
 *   needed: number,
 *   cards: any[],
 *   cardIds: string[],
 *   pointsLost: number,
 * }} SacrificeInfo
 */

const KNOWN_TOKEN_TYPES = ["Green", "White", "Blue", "Brown", "Red", "Satchel", "Gold"];

/**
 * Whether a card cannot be bought yet: an unassigned Satchel card and no gem-bonus card to pair it with.
 * @param {any} card @param {any} player
 */
export const satchelBlocked = (card, player) => card?.tokenType === "Satchel" && !ownsGemBonusCard(player);

/**
 * What each gem colour still costs after the player's bonuses:
 * max(0, cost - bonus), for every gem in display order.
 * @param {any} card @param {any} player
 * @returns {TokenMap}
 */
export function stillOwed(card, player) {
    /** @type {TokenMap} */
    const out = {};
    for (const g of GEMS) out[g] = Math.max(0, amount(card?.tokenCost, g) - amount(player?.bonuses, g));
    return out;
}

/**
 * One breakdown row per colour the card costs, in display order:
 * "cost − bonus = owed · have N" and what is short in tokens of that colour.
 * @param {any} card @param {any} player
 * @returns {Array<{ colour: string, cost: number, bonus: number, owed: number, have: number, short: number }>}
 */
export function costRows(card, player) {
    return GEMS.filter((g) => amount(card?.tokenCost, g) > 0).map((g) => {
        const cost = amount(card.tokenCost, g);
        const bonus = amount(player?.bonuses, g);
        const owed = Math.max(0, cost - bonus);
        const have = amount(player?.tokens, g);
        return { colour: g, cost, bonus, owed, have, short: Math.max(0, owed - have) };
    });
}

/**
 * Gems still uncovered when `units` gold (each worth `gv` gems of one colour)
 * cover the per-colour deficits as well as they can.
 * @param {number[]} deficits @param {number} units @param {number} gv
 */
function uncovered(deficits, units, gv) {
    const sum = deficits.reduce((s, d) => s + d, 0);
    if (gv <= 1) return Math.max(0, sum - units);
    const pairs = deficits.reduce((s, d) => s + Math.floor(d / 2), 0);
    const odd = deficits.filter((d) => d % 2 === 1).length;
    const full = Math.min(units, pairs);
    const covered = 2 * full + Math.min(units - full, odd);
    return Math.max(0, sum - covered);
}

/**
 * Card.checkPayment, line for line: validate offering exactly `offered` for
 * `card`. Never changes anything. `code` is the server's ActionResult name
 * (VALID_ACTION when ok). It does not check the Satchel prerequisite, which
 * the server checks in BuyCardAction before calling checkPayment (see
 * satchelBlocked).
 *
 * Extra fields for the payment editor: `colour` (the first over-paid colour,
 * "Gold" for too much gold), `shortBy` (gems still missing when the payment
 * is too low), and the gold-bonus figures of an accepted payment.
 * @param {any} card @param {any} player @param {any} offered
 * @returns {PaymentCheck}
 */
export function checkPayment(card, player, offered) {
    /** @type {PaymentCheck} */
    const res = {
        ok: false, code: "INVALID_TOKENS_GIVEN", goldNeeded: 0, goldOffered: 0, goldBonusesUsed: 0,
        goldBonusesToRemove: 0, goldCardsToDiscard: 0, goldBonusesWasted: 0, shortBy: 0,
    };
    /** @param {string} code @param {Partial<PaymentCheck>} [extra] */
    const reject = (code, extra = {}) => Object.assign(res, { ok: false, code }, extra);
    const offer = offered && typeof offered === "object" ? offered : {};
    // ActionJson.tokenAmounts and the first loop of checkPayment
    for (const [t, a] of Object.entries(offer)) {
        if (!KNOWN_TOKEN_TYPES.includes(t)) return reject("INVALID_TOKENS_GIVEN", { colour: t });
        if (typeof a !== "number" || !Number.isInteger(a) || a < 0) return reject("INVALID_TOKENS_GIVEN", { colour: t });
        if (t === "Satchel" && a > 0) return reject("INVALID_TOKENS_GIVEN", { colour: t });
    }
    // player.hasTokens(offered)
    for (const [t, a] of Object.entries(offer)) {
        if (amount(player?.tokens, t) - a < 0) return reject("NOT_ENOUGH_TOKENS_IN_INVENTORY", { colour: t });
    }
    const bonuses = player?.bonuses;

    if (card?.costType === "Bonus") {
        if (total(offer) > 0) return reject("PAYMENT_TOO_HIGH");
        for (const g of SERVER_GEM_ORDER) {
            if (amount(card.tokenCost, g) > amount(bonuses, g)) {
                const short = GEMS.reduce((s, c) => s + Math.max(0, amount(card.tokenCost, c) - amount(bonuses, c)), 0);
                return reject("NOT_ENOUGH_BONUSES", { colour: g, shortBy: short });
            }
        }
        return Object.assign(res, { ok: true, code: "VALID_ACTION" });
    }

    const gv = goldValue(player);
    let goldNeeded = 0;
    /** @type {number[]} */
    const deficits = [];
    for (const g of SERVER_GEM_ORDER) {
        const owed = Math.max(0, amount(card?.tokenCost, g) - amount(bonuses, g));
        const paid = amount(offer, g);
        if (paid > owed) return reject("PAYMENT_TOO_HIGH", { colour: g });
        const deficit = owed - paid;
        deficits.push(deficit);
        goldNeeded += Math.ceil(deficit / gv);
    }
    const goldOffered = amount(offer, "Gold");
    res.goldNeeded = goldNeeded;
    res.goldOffered = goldOffered;
    if (goldOffered > goldNeeded) return reject("PAYMENT_TOO_HIGH", { colour: "Gold" });

    const used = goldNeeded - goldOffered;
    const owned = amount(bonuses, "Gold");
    if (used > owned) {
        return reject("PAYMENT_TOO_LOW", { goldBonusesUsed: used, shortBy: uncovered(deficits, goldOffered + owned, gv) });
    }
    const cards = Math.ceil(used / 2);
    const toRemove = Math.min(owned, cards * 2);
    return Object.assign(res, {
        ok: true, code: "VALID_ACTION",
        goldBonusesUsed: used, goldBonusesToRemove: toRemove, goldCardsToDiscard: cards, goldBonusesWasted: toRemove - used,
    });
}

/**
 * The cards a sacrifice (a card whose costType is "Bonus") discards, as
 * OrientPlayer.burnBonuses and findOptimizedBurn choose them: among the
 * player's cards of the cost colour, two single-bonus cards (satchels first,
 * then the fewest prestige) or one double-bonus card, whichever loses fewer
 * points (two singles on a tie; always the singles when a satchel leads).
 * Returns null for a card that is not a sacrifice.
 * @param {any} card @param {any} player
 * @returns {SacrificeInfo | null}
 */
export function sacrificeInfo(card, player) {
    if (!card || card.costType !== "Bonus" || typeof card.cardTier !== "string") return null;
    const colour = SERVER_GEM_ORDER.find((g) => amount(card.tokenCost, g) > 0) ?? null;
    const ok = GEMS.every((g) => amount(card.tokenCost, g) <= amount(player?.bonuses, g));
    /** @type {any[]} */
    let remove = [];
    if (colour) {
        /** @type {any[]} */
        const singles = [];
        /** @type {any} */
        let lowestDouble = null;
        for (const c of player?.devCards || []) {
            if (c?.tokenType !== colour) continue;
            if (c.bonus === 2) {
                if (!lowestDouble || amount(c, "prestigePoints") < amount(lowestDouble, "prestigePoints")) lowestDouble = c;
            } else if (c.bonus === 1) {
                singles.push(c);
            }
        }
        const sat = (/** @type {any} */ c) => c?.isSatchel === true;
        // Array.prototype.sort is stable, like Java's List.sort
        singles.sort((a, b) => (sat(a) !== sat(b) ? (sat(a) ? -1 : 1) : amount(a, "prestigePoints") - amount(b, "prestigePoints")));
        if (singles.length < 2) remove = lowestDouble ? [lowestDouble] : [];
        else if (!lowestDouble || sat(singles[0])) remove = singles.slice(0, 2);
        else {
            const singlesPoints = amount(singles[0], "prestigePoints") + amount(singles[1], "prestigePoints");
            remove = singlesPoints > amount(lowestDouble, "prestigePoints") ? [lowestDouble] : singles.slice(0, 2);
        }
    }
    return {
        ok,
        colour,
        needed: colour ? amount(card.tokenCost, colour) : 0,
        cards: remove,
        cardIds: remove.map((c) => c.id),
        pointsLost: remove.reduce((s, c) => s + amount(c, "prestigePoints"), 0),
    };
}

/**
 * The payment the card sheet fills in, per colour: need = max(0, cost −
 * bonus), pay = min(need, tokens), deficit = need − pay, goldNeeded =
 * Σ ceil(deficit / goldValue).
 *
 * - With gold worth 2, a colour whose deficit is odd pays one fewer token of
 *   that colour (listed in `keptByGold`): the gold count is unchanged, so a
 *   token is saved ("Gold covers 2 Red, so you keep 1 Red").
 * - Gold tokens are used first, then gold bonuses (double-gold cards). When
 *   that leaves an odd number of gold bonuses, one more bonus replaces a gold
 *   token: the same card is discarded either way, so its second bonus is not
 *   wasted. `preferGoldCards` uses gold bonuses first instead.
 * - A sacrifice card pays nothing: `tokens` is all zero and ok means the
 *   bonuses cover every cost colour (see `sacrifice` for what it discards).
 * - An unassigned Satchel card without a gem-bonus card is never ok
 *   (code SATCHEL_NEEDS_GEM_CARD).
 *
 * `tokens` always carries the six TOKEN_KEYS, ready for BUY_CARD. When ok,
 * checkPayment accepts it. When not ok, `shortBy` is how many more gems
 * (or bonuses, for a sacrifice) the player needs.
 * `opts` may be omitted or null.
 * @param {any} card @param {any} player @param {{ preferGoldCards?: boolean } | null} [opts]
 * @returns {AutoPayment}
 */
export function autoPayment(card, player, opts) {
    const preferGoldCards = opts?.preferGoldCards === true;
    const gv = goldValue(player);
    /** @type {AutoPayment} */
    const res = {
        ok: false, code: "PAYMENT_TOO_LOW", tokens: fullTokenMap({}), bonusCost: false, goldValue: gv,
        goldNeeded: 0, goldTokens: 0, goldBonusesUsed: 0, goldCardsDiscarded: 0, goldBonusesWasted: 0,
        keptByGold: [], shortBy: 0, spent: 0, sacrifice: null,
    };
    if (!card || !player) return Object.assign(res, { code: "NO_CARD" });

    if (card.costType === "Bonus") {
        const sacrifice = sacrificeInfo(card, player);
        const short = GEMS.reduce((s, g) => s + Math.max(0, amount(card.tokenCost, g) - amount(player.bonuses, g)), 0);
        Object.assign(res, { bonusCost: true, sacrifice, shortBy: short });
        if (satchelBlocked(card, player)) return Object.assign(res, { code: "SATCHEL_NEEDS_GEM_CARD" });
        const check = checkPayment(card, player, res.tokens);
        return Object.assign(res, { ok: check.ok, code: check.code });
    }

    /** @type {TokenMap} */
    const pay = fullTokenMap({});
    /** @type {number[]} */
    const rawDeficits = [];
    let goldNeeded = 0;
    for (const g of GEMS) {
        const need = Math.max(0, amount(card.tokenCost, g) - amount(player.bonuses, g));
        let use = Math.min(need, amount(player.tokens, g));
        rawDeficits.push(need - use);
        let deficit = need - use;
        if (gv === 2 && use > 0 && deficit % 2 === 1) {
            use -= 1;
            deficit += 1;
            res.keptByGold.push(g);
        }
        pay[g] = use;
        goldNeeded += Math.ceil(deficit / gv);
    }
    const heldGold = amount(player.tokens, "Gold");
    const owned = amount(player.bonuses, "Gold");
    let goldTokens;
    let used;
    if (preferGoldCards) {
        used = Math.min(goldNeeded, owned);
        goldTokens = goldNeeded - used;
    } else {
        goldTokens = Math.min(goldNeeded, heldGold);
        used = goldNeeded - goldTokens;
        if (used % 2 === 1 && goldTokens > 0 && used + 1 <= owned) {
            used += 1;
            goldTokens -= 1;
        }
    }
    res.goldNeeded = goldNeeded;
    if (satchelBlocked(card, player)) {
        res.code = "SATCHEL_NEEDS_GEM_CARD";
        res.shortBy = uncovered(rawDeficits, heldGold + owned, gv);
        return res;
    }
    if (goldTokens > heldGold || used > owned) {
        res.code = "PAYMENT_TOO_LOW";
        res.shortBy = uncovered(rawDeficits, heldGold + owned, gv);
        res.keptByGold = [];
        return res;
    }
    pay.Gold = goldTokens;
    const check = checkPayment(card, player, pay);
    if (!check.ok) {
        // unreachable when the mirror and the builder agree; kept as a guard
        return Object.assign(res, { code: check.code, keptByGold: [], shortBy: check.shortBy });
    }
    return Object.assign(res, {
        ok: true, code: "VALID_ACTION", tokens: pay,
        goldTokens, goldBonusesUsed: check.goldBonusesUsed, goldCardsDiscarded: check.goldCardsToDiscard,
        goldBonusesWasted: check.goldBonusesWasted, spent: total(pay),
    });
}

/**
 * Both payment routes for a card: the standard one (gold tokens first) and
 * the double-gold-card one. `distinct` is true when both are valid and
 * differ, which is when the card sheet offers "Use double-gold card first".
 * @param {any} card @param {any} player
 */
export function paymentRoutes(card, player) {
    const standard = autoPayment(card, player);
    const goldCards = autoPayment(card, player, { preferGoldCards: true });
    const distinct = standard.ok && goldCards.ok
        && (standard.goldTokens !== goldCards.goldTokens || standard.goldBonusesUsed !== goldCards.goldBonusesUsed);
    return { standard, goldCards, distinct };
}

/**
 * Whether the player can buy the card now: "yes" with gems and bonuses
 * alone, "gold" when the payment needs gold tokens or gold bonuses, "no"
 * otherwise. `shortBy` is how many more gems (or bonuses) are missing.
 * `reason` says why it is "no": "short", "bonuses" (a sacrifice) or
 * "satchel" (an unassigned Satchel card and no gem card yet).
 * @param {any} card @param {any} player
 * @returns {{ level: "yes" | "gold" | "no", shortBy: number, reason: "short" | "bonuses" | "satchel" | null }}
 */
export function canAfford(card, player) {
    if (!card || !player) return { level: "no", shortBy: 0, reason: "short" };
    const pay = autoPayment(card, player);
    if (pay.ok) return { level: pay.goldTokens + pay.goldBonusesUsed > 0 ? "gold" : "yes", shortBy: 0, reason: null };
    if (pay.code === "SATCHEL_NEEDS_GEM_CARD") return { level: "no", shortBy: pay.shortBy, reason: "satchel" };
    return { level: "no", shortBy: pay.shortBy, reason: pay.bonusCost ? "bonuses" : "short" };
}

/**
 * Whether the player may reserve now (ReserveCardAction) and what happens to
 * the gold:
 *   gain          the bank has gold and the player holds fewer than 10 tokens;
 *   bank-empty    no gold left, the card is reserved without one;
 *   needs-return  the player holds 10: taking the gold means returning one
 *                 token (putBackToken), or reserving without the gold.
 * `card` (a card or an id) is optional; when given it must be on the market.
 * `reason` is player copy, empty when ok; `code` is machine-readable.
 * @param {any} state @param {any} player @param {any} [card]
 * @returns {{ ok: boolean, reason: string, code: string, gold: "gain" | "bank-empty" | "needs-return" }}
 */
export function reserveOutcome(state, player, card) {
    const p = resolvePlayer(state, player);
    const held = total(p?.tokens);
    /** @type {"gain" | "bank-empty" | "needs-return"} */
    const gold = amount(state?.tokens, "Gold") < 1 ? "bank-empty" : held >= MAX_TOKENS ? "needs-return" : "gain";
    /** @param {string} code @param {string} reason */
    const no = (code, reason) => ({ ok: false, reason, code, gold });
    if (!p) return no("NOT_SEATED", "You are watching this game");
    if (state?.gameOver) return no("GAME_OVER", "The game is over");
    if (currentPlayer(state)?.name !== p.name) return no("NOT_YOUR_TURN", "Not your turn");
    if (Array.isArray(state?.curValidActions) && !state.curValidActions.includes("RESERVE_CARD")) {
        return no("ACTION_NOT_ALLOWED", "Finish your turn first");
    }
    if ((p.reservedCards || []).length >= MAX_RESERVED) return no("MAXIMUM_CARDS_RESERVED", "You hold 3 reserved cards");
    if (card !== undefined && card !== null) {
        const id = typeof card === "string" ? card : card.id;
        const where = locateCard(state, id);
        if (!where || where.where === "owned") return no("CARD_GONE", "This card is gone");
        if (where.where === "reserved") return no("ALREADY_RESERVED", "This card is already reserved");
    }
    return { ok: true, reason: "", code: "OK", gold };
}

/**
 * Tokens the player may hand back when reserving at 10 tokens: every gem
 * colour they hold, then Gold (the gold just taken may go straight back).
 * @param {any} player
 * @returns {string[]}
 */
export const reserveReturnOptions = (player) => [...GEMS.filter((g) => amount(player?.tokens, g) > 0), "Gold"];

/**
 * The RESERVE_CARD body.
 * @param {string} cardId @param {string | null} [putBackToken]
 */
export const buildReservePayload = (cardId, putBackToken) =>
    (putBackToken && (isGem(putBackToken) || putBackToken === "Gold") ? { cardId, putBackToken } : { cardId });

/**
 * The BUY_CARD body, with all six token keys.
 * @param {string} cardId @param {any} tokens
 */
export const buildBuyPayload = (cardId, tokens) => ({ cardId, tokens: fullTokenMap(tokens) });
