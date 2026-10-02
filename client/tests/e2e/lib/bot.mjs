// @ts-check
/**
 * A deterministic Splendor bot and a full-game driver.
 *
 * Plain ES module with no dependencies outside this folder, usable from
 * Playwright specs and from plain Node 24 (for example the Chrome CDP skill).
 *
 *   nextAction(state, playerName, { seed })  -> { action, body, reason } | null
 *   playGame({ api, players, version, seed, maxTurns, onStep, actor })
 *
 * nextAction is a pure function of the Game Service state and the seed: the
 * same state and seed always give the same move. Player names do not count,
 * only seats, so a rerun with fresh users (the names carry a per-run suffix)
 * plays the same moves from the same deal. It only proposes moves that
 * are legal under the official rules (see rules.mjs), and never relies on
 * server leniency: no Gold in TAKE_TOKEN, no negative amounts, no
 * overpayment, cascades only into the right tier, 2 of a colour only from a
 * pile of at least 4, at most 3 reserved cards, putBackTokens only down to
 * exactly 10.
 *
 * Strategy, kept simple but reliably finishing games:
 *   1. Answer pending follow-ups (cascade, satchel colour, nobles, city,
 *      Trading Posts extra token).
 *   2. Buy the best affordable card: prestige first, then bonuses in colours
 *      that nobles, cities and Trading Posts powers still need, minus what it
 *      costs.
 *   3. Otherwise pick a target card (value per turns still needed) and take
 *      tokens toward it, returning the least useful tokens above 10.
 *   4. Reserve when token taking cannot help, now and then to collect gold.
 *   5. Pass (an empty TAKE_TOKEN) only when nothing else is possible.
 */
import {
    GEMS, MAIN_ACTIONS, MAX_RESERVED, MAX_TOKENS,
    amount, total, currentPlayer, findPlayer, visibleCards, boardDevCards, tierOf,
    isGem, ownsGemBonusCard, isUnassignedSatchel, goldValue, hasDoublePlusOne,
    paymentFor, shortfall, bonusGap, qualifiedNobles, qualifiedCities, sameColourBest,
    isCitiesVersion, isTradingPostsVersion, reachedEndCondition,
    stateViolations, initialStateViolations, finalStateViolations,
} from "./rules.mjs";

export * from "./rules.mjs";

/** Raised when the bot cannot find a legal move, or a game breaks a rule. */
export class BotError extends Error {
    /** @param {string} message @param {Record<string, unknown>} [details] */
    constructor(message, details = {}) {
        super(message);
        this.name = "BotError";
        Object.assign(this, details);
    }
}

// ------------------------------------------------------------ randomness

/** 32-bit string hash (FNV-1a). @param {string} text */
export const hashString = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
};

/** Seeded PRNG (mulberry32), returns floats in [0, 1). @param {number} seed */
export const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/**
 * A short fingerprint of the parts of the state a decision depends on. The
 * player is identified by seat, not name: usernames differ from run to run.
 * @param {any} state @param {string} name
 */
const fingerprint = (state, name) => {
    const me = findPlayer(state, name) || {};
    return [
        (state.players || []).indexOf(me), state.turnCounter, (state.curValidActions || []).join("+"),
        GEMS.map((g) => amount(state.tokens, g)).join("."), amount(state.tokens, "Gold"),
        (me.devCards || []).length, (me.reservedCards || []).length, total(me.tokens),
        boardDevCards(state).map(({ card }) => card.id).join("."),
    ].join("|");
};

/** Deterministic rng for one decision. @param {any} state @param {string} name @param {number} seed */
const rngFor = (state, name, seed) => mulberry32(hashString(`${seed}#${fingerprint(state, name)}`));

/**
 * Pick the item with the highest score; ties are broken by the rng so that
 * different seeds explore different games.
 * @template T
 * @param {T[]} items @param {(item: T) => number} score @param {() => number} rng
 * @returns {T | undefined}
 */
const best = (items, score, rng) => {
    let top;
    let topScore = -Infinity;
    for (const item of items) {
        const s = score(item) + rng() * 1e-3;
        if (s > topScore) { top = item; topScore = s; }
    }
    return top;
};

// ------------------------------------------------------------ evaluation

/**
 * How much the player wants one more bonus of each colour: from the nobles
 * they can still get, the cities (in Cities games) and the Trading Posts
 * powers not yet unlocked. Closer goals weigh more.
 * @param {any} state @param {any} me
 * @returns {Record<string, number>}
 */
export function bonusDemand(state, me) {
    /** @type {Record<string, number>} */
    const demand = Object.fromEntries(GEMS.map((g) => [g, 0]));
    /** @param {Record<string, number>} gap @param {number} weight */
    const add = (gap, weight) => {
        const missing = total(gap);
        if (missing === 0) return;
        for (const g of GEMS) if (gap[g] > 0) demand[g] += weight / (1 + missing);
    };
    for (const noble of [...visibleCards(state, "nobleDeck"), ...(me.reservedNobles || [])]) add(bonusGap(noble, me), 3);
    if (isCitiesVersion(state.gameVersion)) {
        for (const city of visibleCards(state, "citiesDeck")) {
            const gap = bonusGap(city, me);
            const same = sameColourBest(city, me);
            const sameNeed = Math.max(0, amount(city, "numSameBonuses") - same.have);
            if (sameNeed > 0) {
                // grow the colour already furthest along, or any colour the city does not name
                const colour = same.colour ?? GEMS.find((g) => amount(city.tokenCost, g) === 0) ?? GEMS[0];
                gap[colour] = (gap[colour] || 0) + sameNeed;
            }
            const pointsShort = Math.max(0, amount(city, "prestigePoints") - amount(me, "prestigePoints"));
            add(gap, 8 / (1 + pointsShort / 4));
        }
    }
    if (isTradingPostsVersion(state.gameVersion)) {
        const powers = [
            ["extraTokenAfterPurchase", { Red: 3, White: 1 }],
            ["extraTokenAfterTakingSameColor", { White: 2 }],
            ["goldTokenWorthTwoTokens", { Blue: 3, Brown: 1 }],
            ["addFivePrestigePoints", { Green: 5 }],
            ["addPrestigePointsWithCoatsOfArms", { Brown: 3 }],
        ];
        for (const [key, req] of powers) {
            if (me[/** @type {string} */ (key)]?.unlocked) continue;
            add(bonusGap({ tokenCost: req }, me), 1.5);
        }
    }
    return demand;
}

/** Prestige lost when a "Bonus"-cost card burns cards (the server burns the cheapest). @param {any} card @param {any} me */
const burnLoss = (card, me) => {
    const colour = GEMS.find((g) => amount(card.tokenCost, g) > 0);
    if (!colour) return 0;
    const need = amount(card.tokenCost, colour);
    const cards = (me.devCards || []).filter((/** @type {any} */ c) => c.tokenType === colour)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => amount(a, "prestigePoints") - amount(b, "prestigePoints"));
    let loss = 0;
    let burned = 0;
    for (const c of cards) {
        if (burned >= need) break;
        burned += amount(c, "bonus");
        loss += amount(c, "prestigePoints");
    }
    return loss;
};

/**
 * Value of owning a card: prestige, plus its bonus where it is wanted.
 * @param {any} state @param {any} card @param {any} me @param {Record<string, number>} demand
 */
const cardValue = (state, card, me, demand) => {
    let value = amount(card, "prestigePoints") * 10;
    const t = card.tokenType;
    if (isGem(t)) value += amount(card, "bonus") * (2 + 4 * (demand[t] || 0));
    else if (t === "Gold") value += 2.5; // two gold bonuses, spent once
    else if (t === "Satchel") value += 2 + 4 * Math.max(0, ...GEMS.map((g) => demand[g] || 0));
    if (card.costType === "Bonus") value -= burnLoss(card, me) * 10 + 4;
    if (card.cascadeType && card.cascadeType !== "None") value += 6; // a free card
    if (card.reserveNoble && visibleCards(state, "nobleDeck").length) value += 3;
    return value;
};

/**
 * Cards the player could aim for: visible development cards and their own
 * reserved cards, minus those they can never buy as things stand (a Satchel
 * card without a gem bonus card, a "Bonus"-cost card without the bonuses).
 * @param {any} state @param {any} me
 */
const candidateCards = (state, me) => [
    ...boardDevCards(state).map(({ card, deck }) => ({ card, deck, reserved: false })),
    ...(me.reservedCards || []).map((/** @type {any} */ card) => ({ card, deck: null, reserved: true })),
].filter(({ card }) => !(isUnassignedSatchel(card) && !ownsGemBonusCard(me)));

// ------------------------------------------------------------ follow-ups

/** @typedef {{ action: string, body: Record<string, unknown>, reason: string }} Move */

/**
 * @param {any} state @param {any} me @param {() => number} rng @param {string} action
 * @returns {Move | null}
 */
function cascadeMove(state, me, rng, action) {
    const tier = action === "CASCADE_1" ? "TIER_1" : "TIER_2";
    const decks = tier === "TIER_1" ? ["tier1Deck", "tier1OrientDeck"] : ["tier2Deck", "tier2OrientDeck"];
    let choices = decks.flatMap((deck) => visibleCards(state, deck).map((card) => ({ card, deck })))
        .filter(({ card, deck }) => tierOf(card, deck) === tier);
    if (!ownsGemBonusCard(me)) choices = choices.filter(({ card }) => !isUnassignedSatchel(card));
    if (!choices.length) return null;
    const demand = bonusDemand(state, me);
    const noNobles = visibleCards(state, "nobleDeck").length === 0;
    const pick = best(choices, ({ card }) => cardValue(state, card, me, demand) - (card.reserveNoble && noNobles ? 50 : 0), rng);
    return pick ? { action, body: { cardId: pick.card.id }, reason: `free ${tier} card ${pick.card.id}` } : null;
}

/** @param {any} state @param {any} me @param {() => number} rng @returns {Move | null} */
function satchelMove(state, me, rng) {
    const satchel = (me.devCards || []).find(isUnassignedSatchel);
    const colours = [...new Set((me.devCards || []).map((/** @type {any} */ c) => c.tokenType).filter(isGem))];
    if (!satchel || !colours.length) return null;
    const demand = bonusDemand(state, me);
    const colour = best(colours, (g) => 4 * (demand[g] || 0) + amount(me.bonuses, g) * 0.1, rng);
    return { action: "CHOOSE_SATCHEL_TOKEN", body: { cardId: satchel.id, selected: colour }, reason: `satchel ${satchel.id} as ${colour}` };
}

/** @param {any} state @param {any} me @param {() => number} rng @returns {Move | null} */
function reserveNobleMove(state, me, rng) {
    const nobles = visibleCards(state, "nobleDeck");
    if (!nobles.length) return null;
    const noble = best(nobles, (n) => -total(bonusGap(n, me)), rng);
    return { action: "RESERVE_NOBLE", body: { cardId: noble.id }, reason: `reserve noble ${noble.id}` };
}

/** @param {any} state @param {any} me @param {() => number} rng @returns {Move | null} */
function chooseNobleMove(state, me, rng) {
    const nobles = qualifiedNobles(state, me);
    if (!nobles.length) return null;
    const noble = best(nobles, (n) => amount(n, "prestigePoints"), rng);
    return { action: "CHOOSE_NOBLE", body: { cardId: noble.id }, reason: `noble ${noble.id}` };
}

/** @param {any} state @param {any} me @param {() => number} rng @returns {Move | null} */
function chooseCityMove(state, me, rng) {
    let cities = qualifiedCities(state, me);
    if (!cities.length) {
        // Fall back to the server's own list, restricted to cities still on the board.
        const visible = new Set(visibleCards(state, "citiesDeck").map((c) => c.id));
        cities = (me.citiesQualifiedFor || []).filter((/** @type {any} */ c) => visible.has(c.id));
    }
    if (!cities.length) return null;
    const city = best(cities, (c) => amount(c, "prestigePoints"), rng);
    return { action: "CHOOSE_CITY", body: { cityId: city.id }, reason: `city ${city.id}` };
}

/** @param {any} state @param {any} me @param {() => number} rng @returns {Move} */
function extraTokenMove(state, me, rng) {
    const need = tokenNeed(state, me, rng);
    const onBoard = GEMS.filter((g) => amount(state.tokens, g) > 0);
    if (!onBoard.length) return { action: "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER", body: {}, reason: "extra token: bank is empty, skip" };
    const take = /** @type {string} */ (best(onBoard, (g) => need[g] || 0, rng));
    if (total(me.tokens) + 1 <= MAX_TOKENS) {
        return { action: "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER", body: { takeToken: take }, reason: `extra ${take}` };
    }
    const held = [...GEMS, "Gold"].filter((t) => amount(me.tokens, t) > 0 && t !== take);
    const giveBack = best(held, (t) => -(need[t] || 0) - (t === "Gold" ? 5 : 0), rng);
    if (!giveBack || (need[giveBack] || 0) >= (need[take] || 0)) {
        return { action: "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER", body: {}, reason: "extra token: at 10 tokens, skip" };
    }
    return {
        action: "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
        body: { takeToken: take, putBackToken: giveBack },
        reason: `extra ${take} for ${giveBack}`,
    };
}

/** @type {Record<string, (state: any, me: any, rng: () => number, action: string) => Move | null>} */
const FOLLOW_UPS = {
    CASCADE_1: cascadeMove,
    CASCADE_2: cascadeMove,
    CHOOSE_SATCHEL_TOKEN: satchelMove,
    RESERVE_NOBLE: reserveNobleMove,
    CHOOSE_NOBLE: chooseNobleMove,
    CHOOSE_CITY: chooseCityMove,
    TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER: extraTokenMove,
};

// ------------------------------------------------------------ main actions

/**
 * The card worth working toward, with what it still lacks. Value per turn
 * still needed, so cheap useful cards beat distant big ones early on.
 * @param {any} state @param {any} me @param {() => number} rng
 */
function chooseTarget(state, me, rng) {
    const demand = bonusDemand(state, me);
    const options = candidateCards(state, me).filter(({ card }) => card.costType !== "Bonus").map((c) => {
        const gap = shortfall(c.card, me);
        // a card owing more than 10 after bonuses cannot be bought yet in one go
        const tooDear = gap.owedTotal > MAX_TOKENS + amount(me.tokens, "Gold");
        const turns = Math.ceil(gap.total / 3) + 1;
        const score = (cardValue(state, c.card, me, demand) + 4) / turns - (tooDear ? 100 : 0) + (c.reserved ? 2 : 0);
        return { ...c, gap, score };
    });
    return best(options, (o) => o.score, rng) ?? null;
}

/**
 * How much the player wants one more token of each colour: mostly the
 * target's shortfall (3 per missing token), plus a little from the other
 * cards in reach.
 * @param {any} state @param {any} me @param {() => number} rng @param {any} [target] from chooseTarget
 * @returns {Record<string, number>}
 */
function tokenNeed(state, me, rng, target = chooseTarget(state, me, rng)) {
    /** @type {Record<string, number>} */
    const need = Object.fromEntries([...GEMS, "Gold"].map((g) => [g, 0]));
    need.Gold = 1; // gold pays for anything
    if (target) for (const g of GEMS) need[g] += 3 * target.gap.perColour[g];
    const demand = bonusDemand(state, me);
    for (const { card } of candidateCards(state, me)) {
        if (card.costType === "Bonus") continue;
        const gap = shortfall(card, me);
        const weight = (amount(card, "prestigePoints") + 1 + amount(card, "bonus") * (demand[card.tokenType] || 0)) / (1 + gap.total);
        for (const g of GEMS) if (gap.perColour[g] > 0) need[g] += 0.25 * weight;
    }
    return need;
}

/**
 * Tokens to return so the player ends with exactly 10, taken from what they
 * held before this action (so the move is legal under either reading of the
 * put-back rule), least useful first, gold last.
 * @param {any} me @param {Record<string, number>} take @param {Record<string, number>} need @param {() => number} rng
 * @returns {Record<string, number>}
 */
function putBackFor(me, take, need, rng) {
    let excess = total(me.tokens) + total(take) - MAX_TOKENS;
    /** @type {Record<string, number>} */
    const back = {};
    /** @type {Record<string, number>} */
    const left = {};
    for (const t of [...GEMS, "Gold"]) left[t] = amount(me.tokens, t);
    while (excess > 0) {
        const choices = [...GEMS, "Gold"].filter((t) => left[t] > 0);
        // prefer colours not being taken, then the least needed, then Gold last
        const t = /** @type {string} */ (best(choices, (c) => -(need[c] || 0) - (take[c] ? 2 : 0) - (c === "Gold" ? 50 : 0), rng));
        back[t] = (back[t] || 0) + 1;
        left[t]--;
        excess--;
    }
    return back;
}

/**
 * Take three different gems toward the target, or two of one colour when the
 * target only lacks that colour (and its pile holds at least 4), returning
 * tokens above 10.
 * @param {any} state @param {any} me @param {() => number} rng @param {any} target @param {Record<string, number>} need
 * @returns {Move | null}
 */
function takeTokensMove(state, me, rng, target, need) {
    const available = GEMS.filter((g) => amount(state.tokens, g) > 0);
    if (!available.length) return null;
    const tieBreak = Object.fromEntries(GEMS.map((g) => [g, rng()]));
    const ranked = [...available].sort((a, b) => (need[b] - need[a]) || (tieBreak[a] - tieBreak[b]));
    const lacking = target ? GEMS.filter((g) => target.gap.perColour[g] > 0) : [];

    /** @type {Record<string, number>} */
    let take = {};
    const doubleColour = ranked.find((g) => amount(state.tokens, g) >= 4 && target && target.gap.perColour[g] >= 2);
    if (doubleColour && (lacking.length === 1 || available.length < 3)) {
        take[doubleColour] = 2;
        // Trading Posts power 2: two of one colour plus one of another
        if (hasDoublePlusOne(me)) {
            const extra = ranked.find((g) => g !== doubleColour);
            if (extra) take[extra] = 1;
        }
    } else {
        take = Object.fromEntries(ranked.slice(0, 3).map((g) => [g, 1]));
    }
    const putBack = putBackFor(me, take, need, rng);
    const gain = Object.entries(take).reduce((s, [g, k]) => s + k * need[g], 0) - Object.entries(putBack).reduce((s, [g, k]) => s + k * need[g], 0);
    return {
        action: "TAKE_TOKEN",
        body: { takeTokens: take, putBackTokens: putBack },
        reason: `take ${fmt(take)}${total(putBack) ? `, return ${fmt(putBack)}` : ""} (gain ${gain.toFixed(1)})`,
    };
}

/** @param {any} state @param {any} me @param {any} target @returns {Move | null} */
function reserveMove(state, me, target) {
    if ((me.reservedCards || []).length >= MAX_RESERVED) return null;
    const card = target && !target.reserved ? target.card : null;
    const pick = card ?? boardDevCards(state).map(({ card: c }) => c)
        .sort((a, b) => amount(b, "prestigePoints") - amount(a, "prestigePoints"))[0];
    if (!pick) return null;
    /** @type {Record<string, unknown>} */
    const body = { cardId: pick.id };
    // Official rule: at 10 tokens, take the gold and return one token.
    if (total(me.tokens) >= MAX_TOKENS && amount(state.tokens, "Gold") > 0) {
        const giveBack = GEMS.filter((g) => amount(me.tokens, g) > 0)
            .sort((a, b) => amount(me.tokens, b) - amount(me.tokens, a))[0];
        body.putBackToken = giveBack ?? "Gold";
    }
    return { action: "RESERVE_CARD", body, reason: `reserve ${pick.id}${body.putBackToken ? `, return ${body.putBackToken}` : ""}` };
}

/** @param {any} state @param {any} me @param {() => number} rng @returns {Move} */
function mainMove(state, me, rng) {
    const allowed = new Set(state.curValidActions || []);
    const demand = bonusDemand(state, me);

    if (allowed.has("BUY_CARD")) {
        const affordable = candidateCards(state, me)
            .map((c) => ({ ...c, pay: paymentFor(c.card, me) }))
            .filter((c) => c.pay !== null);
        const worth = (/** @type {any} */ c) => cardValue(state, c.card, me, demand) - 0.6 * c.pay.spent;
        const pick = best(affordable, (c) => worth(c) + (c.reserved ? 3 : 0), rng);
        if (pick && pick.pay && worth(pick) > -5) {
            return {
                action: "BUY_CARD",
                body: { cardId: pick.card.id, tokens: pick.pay.tokens },
                reason: `buy ${pick.card.id} (${amount(pick.card, "prestigePoints")} pts) for ${fmt(pick.pay.tokens) || "nothing"}`,
            };
        }
    }

    const target = chooseTarget(state, me, rng);
    const need = tokenNeed(state, me, rng, target);
    const canReserve = allowed.has("RESERVE_CARD") && (me.reservedCards || []).length < MAX_RESERVED;
    const take = allowed.has("TAKE_TOKEN") ? takeTokensMove(state, me, rng, target, need) : null;
    const usefulTake = take && Object.keys(/** @type {any} */ (take.body.takeTokens)).some((g) => (need[g] || 0) >= 1);
    const goldLeft = amount(state.tokens, "Gold") > 0;

    if (canReserve && target && !target.reserved) {
        const bigAndFar = amount(target.card, "prestigePoints") >= 3 && target.gap.total >= 4;
        if (!usefulTake || (goldLeft && bigAndFar && rng() < 0.35) || (goldLeft && rng() < 0.05)) {
            const move = reserveMove(state, me, target);
            if (move) return move;
        }
    }
    if (take) return take;
    if (canReserve) {
        const move = reserveMove(state, me, target);
        if (move) return move;
    }
    if (!allowed.has("TAKE_TOKEN")) {
        throw new BotError(`no legal main action among ${[...allowed].join(", ")}`, { state });
    }
    return { action: "TAKE_TOKEN", body: { takeTokens: {}, putBackTokens: {} }, reason: "pass: nothing to take, buy or reserve" };
}

/** @param {Record<string, number>} m */
const fmt = (m) => Object.entries(m).filter(([, k]) => k > 0).map(([g, k]) => `${k} ${g}`).join(", ");

/**
 * The bot's next move for `playerName`, or null when it is not their move
 * (or the game is over).
 * @param {any} state Game Service state JSON
 * @param {string} playerName
 * @param {{ seed?: number }} [opts]
 * @returns {Move | null}
 */
export function nextAction(state, playerName, opts = {}) {
    const me = currentPlayer(state);
    if (!me || me.name !== playerName) return null;
    const rng = rngFor(state, playerName, opts.seed ?? 1);
    const pending = /** @type {string[]} */ (state.curValidActions || []);
    const followUps = pending.filter((a) => !(/** @type {readonly string[]} */ (MAIN_ACTIONS)).includes(a));
    for (const action of followUps) {
        const handler = FOLLOW_UPS[action];
        const move = handler ? handler(state, me, rng, action) : null;
        if (move) return move;
    }
    if (followUps.length && !pending.some((a) => (/** @type {readonly string[]} */ (MAIN_ACTIONS)).includes(a))) {
        throw new BotError(`stuck: no legal move for the pending follow-ups ${followUps.join(", ")}`, { state, player: playerName });
    }
    return mainMove(state, me, rng);
}

// ------------------------------------------------------------ full games

/** Whether a TAKE_TOKEN body takes nothing. @param {Move} move */
const isPass = (move) => move.action === "TAKE_TOKEN" && total(/** @type {any} */ (move.body.takeTokens)) === 0;

/**
 * Play one game to the end through the REST APIs.
 *
 * Creates `players` users (or uses the given ones), creates a session of
 * `version` (dealt from `seed` on the fake stack, see createGame's
 * dealSeed), joins and launches it, then plays every seat with nextAction
 * until the Game Service reports game over. After every action it re-reads
 * the state and checks the invariants of rules.stateViolations; after every
 * round it checks that the game ended if someone had reached the goal; at
 * the end it checks that every player had the same number of turns and that
 * the winners follow the official rule. Any violation throws a BotError
 * carrying the state and the last moves.
 *
 * `actor` lets a caller play some moves itself (for example through the
 * board UI): it is called before every move with { state, player, user,
 * move, step, turn, sessionId } and returns true when it performed the move
 * itself, false/undefined to let the bot send `move` over the API.
 *
 * `onStep` is awaited after every action with { state, before, player, move,
 * step, turn, turnEnded, sessionId }.
 *
 * @param {{
 *   api: import("./splendor-api.mjs").SplendorApi,
 *   players?: number | Array<{ username: string, token: string }>,
 *   version?: string,
 *   seed?: number,
 *   maxTurns?: number,
 *   sessionId?: string,
 *   namePrefix?: string,
 *   onStep?: (info: any) => unknown,
 *   actor?: (info: any) => unknown,
 *   log?: (line: string) => void,
 * }} opts
 */
export async function playGame(opts) {
    const {
        api, version = "BASE_ORIENT", seed = 1, maxTurns = 1200, onStep, actor, log,
        namePrefix = "E2E Bot",
    } = opts;
    const users = Array.isArray(opts.players)
        ? opts.players
        : await api.createUsers(opts.players ?? 2, `${namePrefix} ${seed}`);
    const sessionId = opts.sessionId ?? await api.createGame({ users, version, dealSeed: seed });
    const byName = new Map(users.map((u) => [u.username, u]));
    /** @type {Array<{ step: number, turn: number, player: string, action: string, body: unknown, reason: string }>} */
    const moves = [];
    const fail = (/** @type {string} */ message, /** @type {any} */ state, /** @type {Record<string, unknown>} */ extra = {}) =>
        new BotError(`${message} [session ${sessionId}, ${version}, ${users.length} players, seed ${seed}]`, {
            state, sessionId, version, seed, moves: moves.slice(-30), ...extra,
        });

    let state = await api.getState(sessionId);
    const initial = state;
    const setupErrors = initialStateViolations(state, { version, players: users.length });
    if (setupErrors.length) throw fail(`bad initial state:\n  ${setupErrors.join("\n  ")}`, state);

    /** @type {Record<string, number>} */
    const turnsTaken = Object.fromEntries(state.players.map((/** @type {any} */ p) => [p.name, 0]));
    let step = 0;
    let turn = 0;
    let passStreak = 0;
    const isMain = (/** @type {string} */ a) => (/** @type {readonly string[]} */ (MAIN_ACTIONS)).includes(a);

    while (!state.gameOver) {
        if (turn >= maxTurns) throw fail(`no winner after ${maxTurns} turns`, state);
        const me = currentPlayer(state);
        if (!me) throw fail("no current player in a running game", state);
        const user = byName.get(me.name);
        if (!user) throw fail(`seat ${state.turnCounter} is ${me.name}, who is not one of this game's users`, state);
        const turnStart = (state.curValidActions || []).some(isMain);
        const move = nextAction(state, me.name, { seed });
        if (!move) throw fail(`the bot has no move for ${me.name}`, state);

        const before = state;
        const info = { state, player: me.name, user, move, step, turn, sessionId };
        const handled = actor ? await actor(info) : false;
        if (handled) {
            state = await api.waitForChange(sessionId, before, { timeoutMs: 20_000 });
        } else {
            const res = await api.putAction(user, sessionId, move.action, move.body);
            if (!res.ok) {
                throw fail(`${me.name} ${move.action} ${JSON.stringify(move.body)} was rejected: ${res.status} ${res.text}`, before, { move });
            }
            state = await api.getState(sessionId);
        }
        moves.push({ step, turn, player: me.name, action: move.action, body: move.body, reason: move.reason });
        log?.(`#${turn}.${step} ${me.name}: ${handled ? "(ui) " : ""}${move.reason}`);
        step++;
        if (turnStart) turnsTaken[me.name]++;
        passStreak = !handled && isPass(move) ? passStreak + 1 : 0;
        if (passStreak >= 3 * users.length) throw fail(`stuck: ${passStreak} passes in a row`, state);

        const violations = stateViolations(state, { players: users.length });
        if (violations.length) throw fail(`after ${me.name} ${move.action} ${JSON.stringify(move.body)}:\n  ${violations.join("\n  ")}`, state, { before });

        const turnEnded = state.gameOver || currentPlayer(state)?.name !== me.name;
        if (turnEnded) {
            turn++;
            if (!state.gameOver) {
                const expectedSeat = (before.turnCounter + 1) % users.length;
                if (state.turnCounter !== expectedSeat) throw fail(`turn passed from seat ${before.turnCounter} to ${state.turnCounter}`, state, { before });
                // The game ends at the end of the first round in which someone
                // reached the goal: a round that ends with a player there and
                // goes on is a late end (equal turns and the winner check
                // alone would still pass it).
                if (before.turnCounter === users.length - 1) {
                    const atGoal = state.players.filter((/** @type {any} */ p) => reachedEndCondition(state, p)).map((/** @type {any} */ p) => p.name);
                    if (atGoal.length) throw fail(`the round ended with ${atGoal.join(", ")} at the goal, but the game went on`, state, { before });
                }
            }
        } else if ((state.curValidActions || []).some(isMain)) {
            throw fail(`${me.name} got a fresh turn without the turn passing`, state, { before });
        }
        if (onStep) await onStep({ state, before, player: me.name, move, step, turn, turnEnded, sessionId });
    }

    const counts = Object.values(turnsTaken);
    const finalErrors = finalStateViolations(state);
    if (!counts.every((c) => c === counts[0])) finalErrors.push(`players had different numbers of turns: ${JSON.stringify(turnsTaken)}`);
    if (finalErrors.length) throw fail(`bad final state:\n  ${finalErrors.join("\n  ")}`, state);

    return {
        sessionId, users, version, seed, initial, state, moves, turnsTaken,
        turns: turn, steps: step, rounds: counts[0],
        winners: state.winners.map((/** @type {any} */ w) => w.name),
    };
}
