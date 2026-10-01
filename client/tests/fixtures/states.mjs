// @ts-check
/**
 * Hand-built Game Service states, in the exact JSON shape the server sends.
 *
 * The server serialises its model with plain Gson reflection
 * (SplendorTypeAdapter.newClientGson), so these objects carry the Java field
 * names of:
 *   OrientGame       gameVersion, prestigePointsToWin, turnCounter, curValidActions,
 *                    players, tier1Deck..tier3Deck, tier1OrientDeck..tier3OrientDeck,
 *                    nobleDeck, tokens, playersWhoCanWin, winners, gameOver,
 *                    nobleVisitedThisTurn
 *   CitiesGame       + citiesDeck (prestigePointsToWin is -1)
 *   Deck             visibleCards, canDraw (the hidden stack is @HideFromClient)
 *   OrientPlayer     name, colour, prestigePoints, tokens, bonuses, devCards,
 *                    nobleCards, reservedCards, reservedNobles
 *   CitiesPlayer     + cities, citiesQualifiedFor
 *   TradingPostsPlayer + coatsOfArmsUnplaced and one object per power
 *                    ({ requirements, unlocked }, plus isUsed / currentAddedPoints)
 * Token maps always carry all seven TokenType keys. Cards come from the real
 * catalog (cards.mjs), so ids, costs and Orient flags are real.
 */
import { card, emptyTokens } from "./cards.mjs";

export { card };

const MAIN = ["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"];
const DECK_NAMES = ["tier1Deck", "tier2Deck", "tier3Deck", "tier1OrientDeck", "tier2OrientDeck", "tier3OrientDeck", "nobleDeck"];

/** A full token map. @param {Record<string, number>} [partial] */
export const tokens = (partial = {}) => ({ ...emptyTokens(), ...partial });

/**
 * A player. `cards` are owned development card ids: bonuses and prestige are
 * derived from them (as the server keeps them), unless given explicitly.
 * @param {string} name
 * @param {{ tokens?: Record<string, number>, cards?: string[], reserved?: string[], nobles?: string[],
 *   reservedNobles?: string[], bonuses?: Record<string, number>, prestigePoints?: number,
 *   version?: string, powers?: string[], cities?: string[] }} [opts]
 */
export function player(name, opts = {}) {
    const devCards = (opts.cards || []).map(card);
    const nobleCards = (opts.nobles || []).map(card);
    const bonuses = tokens();
    for (const c of devCards) if (c.tokenType !== "Satchel") bonuses[c.tokenType] += c.bonus;
    /** @type {any} */
    const p = {};
    if (opts.version === "BASE_ORIENT_TRADE_ROUTES") {
        const unlocked = new Set(opts.powers || []);
        Object.assign(p, {
            coatsOfArmsUnplaced: 5 - unlocked.size,
            extraTokenAfterPurchase: { requirements: { Red: 3, White: 1 }, unlocked: unlocked.has("extraTokenAfterPurchase") },
            extraTokenAfterTakingSameColor: { requirements: { White: 2 }, unlocked: unlocked.has("extraTokenAfterTakingSameColor") },
            goldTokenWorthTwoTokens: { requirements: { Blue: 3, Brown: 1 }, unlocked: unlocked.has("goldTokenWorthTwoTokens") },
            addFivePrestigePoints: { isUsed: false, requirements: { Green: 5 }, unlocked: unlocked.has("addFivePrestigePoints") },
            addPrestigePointsWithCoatsOfArms: { currentAddedPoints: 0, requirements: { Brown: 3 }, unlocked: unlocked.has("addPrestigePointsWithCoatsOfArms") },
        });
    }
    if (opts.version === "BASE_ORIENT_CITIES" || opts.version === "BASE_ORIENT_CITIES_NOBLES") {
        Object.assign(p, { cities: (opts.cities || []).map(card), citiesQualifiedFor: [] });
    }
    Object.assign(p, {
        name,
        colour: "1E90FF",
        prestigePoints: opts.prestigePoints
            ?? devCards.reduce((s, c) => s + c.prestigePoints, 0) + 3 * nobleCards.length,
        tokens: tokens(opts.tokens),
        bonuses: opts.bonuses ? tokens(opts.bonuses) : bonuses,
        devCards,
        nobleCards,
        reservedCards: (opts.reserved || []).map(card),
        reservedNobles: (opts.reservedNobles || []).map(card),
    });
    return p;
}

/** The default board: real ids, 4 per regular tier, 2 per Orient tier, 3 nobles. */
export const DEFAULT_BOARD = {
    tier1Deck: ["01", "02", "03", "04"],
    tier2Deck: ["041", "042", "043", "044"],
    tier3Deck: ["071", "072", "073", "074"],
    tier1OrientDeck: ["091", "096"],
    tier2OrientDeck: ["101", "106"],
    tier3OrientDeck: ["111", "116"],
    nobleDeck: ["20002", "20003", "20004"],
};

/**
 * A game state. `board` replaces the default decks wholesale when given (a
 * deck left out is empty), so a test controls exactly what is on offer.
 * `bank` defaults to the full supply minus what the players hold.
 * @param {{ version?: string, players?: any[], board?: Record<string, string[]>, bank?: Record<string, number>,
 *   turn?: number, actions?: string[], cities?: string[] }} [opts]
 */
export function game(opts = {}) {
    const version = opts.version ?? "BASE_ORIENT";
    const players = opts.players ?? [player("alice", { version }), player("bob", { version })];
    const isCities = version === "BASE_ORIENT_CITIES" || version === "BASE_ORIENT_CITIES_NOBLES";
    const board = opts.board ?? {
        ...DEFAULT_BOARD,
        nobleDeck: version === "BASE_ORIENT_CITIES" ? [] : DEFAULT_BOARD.nobleDeck.slice(0, players.length + 1),
    };
    const gems = { 2: 4, 3: 5, 4: 7 }[/** @type {2|3|4} */ (players.length)] ?? 4;
    let bank = opts.bank;
    if (!bank) {
        bank = tokens({ Green: gems, White: gems, Blue: gems, Brown: gems, Red: gems, Gold: 5 });
        for (const p of players) for (const [t, k] of Object.entries(p.tokens)) bank[t] -= /** @type {number} */ (k);
    }
    /** @type {any} */
    const s = {};
    if (isCities) s.citiesDeck = { visibleCards: (opts.cities ?? ["40001", "40007", "40008"]).map(card), canDraw: true };
    Object.assign(s, {
        gameVersion: version,
        prestigePointsToWin: isCities ? -1 : 15,
        turnCounter: opts.turn ?? 0,
        curValidActions: opts.actions ?? [...MAIN],
        players,
    });
    for (const d of DECK_NAMES) s[d] = { visibleCards: (board[d] || []).map(card), canDraw: true };
    Object.assign(s, {
        tokens: tokens(bank),
        playersWhoCanWin: [],
        winners: [],
        gameOver: false,
        nobleVisitedThisTurn: false,
    });
    return s;
}
