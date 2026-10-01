// @ts-check
/**
 * Shared, DOM-free rule helpers for the board redesign (WP-RULES).
 *
 * Every function here is pure: it reads the Game Service state JSON (the
 * shape GET /api/sessions/{id} returns, see tests/fixtures/states.mjs) and
 * never touches the DOM, the network or storage. The module has no imports
 * outside this folder, so `node --test` loads it as it is.
 *
 * Conventions shared by all the rule modules:
 *   - A missing field counts as 0, false or empty. A token map may omit keys.
 *   - Colour names are the server's TokenType names. GEMS is the display
 *     order (White, Blue, Green, Red, Brown), not the server's enum order.
 *   - Where a function takes `player`, it accepts either a player object from
 *     the state or a player name, when the function also receives the state.
 *
 * The rules mirror the server model (server/src/main/java/.../model); see
 * docs/ui/rules.md for the mapping and for the places where the client is
 * deliberately stricter than the server.
 */

/** The five gem colours, in display order. */
export const GEMS = /** @type {readonly string[]} */ (Object.freeze(["White", "Blue", "Green", "Red", "Brown"]));
/** Token keys a player can hold, in display order (no Satchel: it is a bonus type, never a token). */
export const TOKEN_KEYS = /** @type {readonly string[]} */ (Object.freeze([...GEMS, "Gold"]));
/** The gems in the server's TokenType enum order (the order its loops visit them). */
export const SERVER_GEM_ORDER = /** @type {readonly string[]} */ (Object.freeze(["Green", "White", "Blue", "Brown", "Red"]));
/** The three main actions; anything else in curValidActions is a follow-up. */
export const MAIN_ACTIONS = /** @type {readonly string[]} */ (Object.freeze(["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"]));
/** Board decks of development cards: regular tiers, then Orient tiers. */
export const DEV_DECKS = /** @type {readonly string[]} */ (Object.freeze([
    "tier1Deck", "tier2Deck", "tier3Deck", "tier1OrientDeck", "tier2OrientDeck", "tier3OrientDeck",
]));
/** Most tokens a player may hold at the end of an action. */
export const MAX_TOKENS = 10;
/** Most development cards a player may hold in reserve. */
export const MAX_RESERVED = 3;
/** Fallback seat colours, by seat index, for invalid or duplicate player colours. */
export const SEAT_PALETTE = /** @type {readonly string[]} */ (Object.freeze(["#3b82f6", "#ef4444", "#22c55e", "#a855f7"]));

/**
 * @typedef {Record<string, number>} TokenMap
 * @typedef {"loading" | "mine" | "followup" | "other" | "spectator" | "over"} Phase
 */

/**
 * A count from a token map; anything that is not a finite number counts as 0.
 * @param {any} map @param {string} key
 */
export const amount = (map, key) => {
    const v = map ? map[key] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/**
 * The sum of a token map's finite numbers.
 * @param {any} map
 */
export const total = (map) => Object.values(map || {}).reduce(
    (/** @type {number} */ s, v) => s + (typeof v === "number" && Number.isFinite(v) ? v : 0), 0);

/**
 * Whether a colour is one of the five gems (not Gold, not an unassigned Satchel).
 * @param {unknown} t
 */
export const isGem = (t) => typeof t === "string" && GEMS.includes(t);

/**
 * Whether an action is a main action.
 * @param {unknown} a
 */
export const isMainAction = (a) => typeof a === "string" && MAIN_ACTIONS.includes(a);

/**
 * A token map with all six TOKEN_KEYS present (missing ones as 0, Satchel left out).
 * @param {any} [partial]
 */
export const fullTokenMap = (partial) => {
    /** @type {TokenMap} */
    const out = {};
    for (const k of TOKEN_KEYS) out[k] = amount(partial, k);
    return out;
};

/**
 * How many gems one gold pays for: 2 once the Trading Posts power
 * goldTokenWorthTwoTokens is unlocked, otherwise 1. A gold bonus (from a
 * double-gold card) is worth the same as a gold token.
 * @param {any} player
 */
export const goldValue = (player) => (player?.goldTokenWorthTwoTokens?.unlocked === true ? 2 : 1);

/**
 * Whether the player owns a development card with a gem bonus (needed before a Satchel card).
 * @param {any} player
 */
export const ownsGemBonusCard = (player) => (player?.devCards || []).some((/** @type {any} */ c) => isGem(c?.tokenType));

/**
 * Whether Trading Posts power 2 (two of a colour plus one other) is unlocked.
 * @param {any} player
 */
export const hasDoublePlusOne = (player) => player?.extraTokenAfterTakingSameColor?.unlocked === true;

/**
 * The player whose turn it is, or null when there is no state or the game is over.
 * @param {any} state
 */
export const currentPlayer = (state) => {
    if (!state || state.gameOver || !Array.isArray(state.players)) return null;
    return state.players[state.turnCounter] ?? null;
};

/**
 * A seated player by name, or null.
 * @param {any} state @param {unknown} name
 */
export const findPlayer = (state, name) => {
    if (typeof name !== "string" || !Array.isArray(state?.players)) return null;
    return state.players.find((/** @type {any} */ p) => p?.name === name) ?? null;
};

/**
 * A player object from a player object or a name.
 * @param {any} state @param {any} who
 */
export const resolvePlayer = (state, who) => {
    if (typeof who === "string") return findPlayer(state, who);
    return who && typeof who === "object" ? who : null;
};

/**
 * The seat index of a player name, or -1.
 * @param {any} state @param {unknown} name
 */
export const seatIndex = (state, name) => {
    if (typeof name !== "string" || !Array.isArray(state?.players)) return -1;
    return state.players.findIndex((/** @type {any} */ p) => p?.name === name);
};

/**
 * The phase of the board for viewer `me` (a username). Precedence: loading
 * (no state), over (gameOver, also for spectators), spectator (not seated),
 * mine (your seat and a main action is pending), followup (your seat and the
 * first pending action is a follow-up), other.
 * @param {any} state @param {any} me
 * @returns {Phase}
 */
export const phaseOf = (state, me) => {
    if (!state || !Array.isArray(state.players)) return "loading";
    if (state.gameOver) return "over";
    const name = typeof me === "string" ? me : me?.name;
    if (!findPlayer(state, name)) return "spectator";
    const cur = currentPlayer(state);
    if (!cur || cur.name !== name) return "other";
    const actions = Array.isArray(state.curValidActions) ? state.curValidActions : [];
    if (actions.some(isMainAction)) return "mine";
    if (actions.length && !isMainAction(actions[0])) return "followup";
    return "other";
};

/**
 * The pending follow-up (curValidActions[0] when it is not a main action), or null.
 * @param {any} state
 */
export const followUpOf = (state) => {
    const first = Array.isArray(state?.curValidActions) ? state.curValidActions[0] : undefined;
    return typeof first === "string" && !isMainAction(first) ? first : null;
};

const HEX6 = /^#?([0-9a-fA-F]{6})$/;

/**
 * The display colour of every seat, in seat order. A player's own colour is
 * used when it is a valid 6-digit hex ("1E90FF" or "#1E90FF") that no
 * earlier seat already uses; otherwise the seat gets SEAT_PALETTE[seat], or
 * the first palette colour still free when that one is taken. Lower case,
 * with the '#'.
 * @param {any} state
 * @returns {string[]}
 */
export const seatColours = (state) => {
    const players = Array.isArray(state?.players) ? state.players : [];
    /** @type {string[]} */
    const out = [];
    const used = new Set();
    players.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
        const m = typeof p?.colour === "string" ? HEX6.exec(p.colour.trim()) : null;
        let colour = m ? `#${m[1].toLowerCase()}` : null;
        if (!colour || used.has(colour)) {
            const own = SEAT_PALETTE[i % SEAT_PALETTE.length];
            colour = !used.has(own) ? own : (SEAT_PALETTE.find((c) => !used.has(c)) ?? own);
        }
        used.add(colour);
        out.push(colour);
    });
    return out;
};

/**
 * The display colour of a seated player, or null for someone not seated.
 * @param {any} state @param {unknown} name
 */
export const seatColour = (state, name) => {
    const i = seatIndex(state, name);
    return i < 0 ? null : seatColours(state)[i];
};

/**
 * Every visible development card on the board, with its deck.
 * @param {any} state
 */
export const marketCards = (state) => DEV_DECKS.flatMap((deck) => {
    const cards = state?.[deck]?.visibleCards;
    return Array.isArray(cards) ? cards.map((/** @type {any} */ card) => ({ card, deck })) : [];
});

/**
 * Where a development card is: on the market, in someone's reserve, or owned.
 * @param {any} state @param {unknown} id
 * @returns {null | { card: any, where: "market" | "reserved" | "owned", deck?: string, owner?: string }}
 */
export const locateCard = (state, id) => {
    if (typeof id !== "string" || !state) return null;
    for (const { card, deck } of marketCards(state)) if (card?.id === id) return { card, where: "market", deck };
    for (const p of state.players || []) {
        const r = (p?.reservedCards || []).find((/** @type {any} */ c) => c?.id === id);
        if (r) return { card: r, where: "reserved", owner: p.name };
    }
    for (const p of state.players || []) {
        const o = (p?.devCards || []).find((/** @type {any} */ c) => c?.id === id);
        if (o) return { card: o, where: "owned", owner: p.name };
    }
    return null;
};

/**
 * A development card by id from the market, any reserve or any tableau, or null.
 * @param {any} state @param {unknown} id
 */
export const cardById = (state, id) => locateCard(state, id)?.card ?? null;

/**
 * The tier of a card as a number (1 to 3), or 0.
 * @param {any} card
 */
export const tierOf = (card) => {
    const m = typeof card?.cardTier === "string" ? /^TIER_(\d)$/.exec(card.cardTier) : null;
    return m ? Number(m[1]) : 0;
};

/**
 * Whether a card is an Orient card (it carries the Orient fields).
 * @param {any} card
 */
export const isOrientCard = (card) => !!card && typeof card === "object" && "isSatchel" in card;

/**
 * The Orient effects of a card, for tags and copy: "cascade" (a free card of
 * the tier below), "reserve-noble", "satchel", "double-gold" and "sacrifice"
 * (paid with bonuses, which discards cards).
 * @param {any} card
 * @returns {string[]}
 */
export const cardTags = (card) => {
    /** @type {string[]} */
    const tags = [];
    if (!card) return tags;
    if (card.cascadeType === "Tier1" || card.cascadeType === "Tier2") tags.push("cascade");
    if (card.reserveNoble === true) tags.push("reserve-noble");
    if (card.isSatchel === true || card.tokenType === "Satchel") tags.push("satchel");
    if (card.tokenType === "Gold") tags.push("double-gold");
    if (card.costType === "Bonus" && typeof card.cardTier === "string") tags.push("sacrifice");
    return tags;
};

/**
 * The cards a cascade may take (OrientGame.getCascadeChoices): the visible
 * cards of that tier, regular row first, then the Orient row, without
 * unassigned Satchel cards when the player owns no gem-bonus card.
 * @param {any} state @param {any} player @param {1 | 2 | string} tier 1, 2, "TIER_1", "CASCADE_1" and so on
 * @returns {any[]}
 */
export const cascadeChoices = (state, player, tier) => {
    const n = typeof tier === "number" ? tier : Number(/(\d)$/.exec(String(tier))?.[1] ?? 0);
    if (n !== 1 && n !== 2) return [];
    const p = resolvePlayer(state, player);
    /** @type {any[]} */
    let cards = [...(state?.[`tier${n}Deck`]?.visibleCards || []), ...(state?.[`tier${n}OrientDeck`]?.visibleCards || [])];
    if (!ownsGemBonusCard(p)) cards = cards.filter((c) => c?.tokenType !== "Satchel");
    return cards;
};

/**
 * Colours a satchel may take (ChooseTokenTypeAction): the gem colours of the
 * player's own development cards (an already assigned satchel counts as its
 * colour; Gold and unassigned satchels do not).
 * @param {any} player
 * @returns {string[]}
 */
export const satchelColours = (player) =>
    GEMS.filter((g) => (player?.devCards || []).some((/** @type {any} */ c) => c?.tokenType === g));

/**
 * The first of the player's cards still waiting for a satchel colour, or null.
 * @param {any} player
 */
export const unassignedSatchel = (player) =>
    (player?.devCards || []).find((/** @type {any} */ c) => c?.tokenType === "Satchel") ?? null;
