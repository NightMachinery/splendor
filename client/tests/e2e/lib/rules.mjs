// @ts-check
/**
 * Pure Splendor rule helpers over the Game Service state JSON.
 *
 * Plain ES module with no imports, so it runs in Playwright specs, in plain
 * Node (node --test, the Chrome CDP skill) and in a browser alike.
 *
 * The state is what GET /api/sessions/{id} returns: the server serialises its
 * model with plain Gson reflection (SplendorTypeAdapter.newClientGson), so the
 * field names below are the Java field names of OrientGame, OrientPlayer,
 * CitiesGame/CitiesPlayer, TradingPostsPlayer and the card classes. Fields
 * that are null on the server are absent from the JSON.
 *
 * The rules follow the official game and the server's model classes
 * (server/src/main/java/ca/hexanome04/splendorgame/model). Where the server
 * once had a bug (winner ignoring prestige, Gold takeable as a gem, negative
 * amounts accepted, cascades of any tier, overpayment accepted), these helpers
 * encode the official rule, never the bug.
 */

/** The five gem colours, in the server's TokenType order. */
export const GEMS = /** @type {const} */ (["Green", "White", "Blue", "Brown", "Red"]);
/** Every TokenType key of a token map. */
export const TOKEN_TYPES = /** @type {const} */ (["Green", "White", "Blue", "Brown", "Red", "Satchel", "Gold"]);

/** Game versions the server registers ("splendor_" + version in the Lobby Service). */
export const GAME_VERSIONS = /** @type {const} */ ([
    "BASE_ORIENT",
    "BASE_ORIENT_CITIES", // Cities without nobles: the official rule and the default
    "BASE_ORIENT_CITIES_NOBLES", // Cities played with nobles as well
    "BASE_ORIENT_TRADE_ROUTES",
]);

/** The three main actions; anything else in curValidActions is a follow-up. */
export const MAIN_ACTIONS = /** @type {const} */ (["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"]);

/** Board decks of development cards, regular then Orient. */
export const DEV_DECKS = /** @type {const} */ ([
    "tier1Deck", "tier2Deck", "tier3Deck", "tier1OrientDeck", "tier2OrientDeck", "tier3OrientDeck",
]);

/** Prestige needed to end a base or Trading Posts game (SessionManager.launchNewGame). */
export const POINTS_TO_WIN = 15;
/** Most tokens a player may hold at the end of an action. */
export const MAX_TOKENS = 10;
/** Most development cards a player may hold in reserve. */
export const MAX_RESERVED = 3;
/** The game-over value of turnCounter (OrientGame.GAME_OVER_TURN_COUNTER). */
export const GAME_OVER_TURN_COUNTER = -10000;

/** @param {string} version */
export const serviceName = (version) => `splendor_${version}`;
/** @param {string | undefined} version */
export const isCitiesVersion = (version) => version === "BASE_ORIENT_CITIES" || version === "BASE_ORIENT_CITIES_NOBLES";
/** @param {string | undefined} version */
export const isTradingPostsVersion = (version) => version === "BASE_ORIENT_TRADE_ROUTES";
/** Whether players + 1 nobles are dealt at the start. @param {string | undefined} version */
export const dealsNobles = (version) => version !== "BASE_ORIENT_CITIES";

/** Board page of each version (client/src/scripts/settings.js GAME_VERSION_TO_BOARD). */
export const BOARD_PATHS = {
    BASE_ORIENT: "/gameboard/",
    BASE_ORIENT_CITIES: "/gameboard-cities/",
    BASE_ORIENT_CITIES_NOBLES: "/gameboard-cities/",
    BASE_ORIENT_TRADE_ROUTES: "/gameboard-tradingposts/",
};

/** Gems of each colour in the bank at the start, by player count (OrientGame.initBoard). @param {number} players */
export const gemsPerColour = (players) => ({ 2: 4, 3: 5, 4: 7 })[players] ?? 0;
/** Gold tokens in the game, for every player count. */
export const GOLD_TOKENS = 5;

/** The full token supply of a game: gems by player count, 5 Gold, no Satchel tokens. @param {number} players */
export const tokenSupply = (players) => {
    /** @type {Record<string, number>} */
    const supply = {};
    for (const t of TOKEN_TYPES) supply[t] = 0;
    for (const g of GEMS) supply[g] = gemsPerColour(players);
    supply.Gold = GOLD_TOKENS;
    return supply;
};

/** @param {Record<string, number> | undefined | null} map @param {string} key */
export const amount = (map, key) => (map && typeof map[key] === "number" ? map[key] : 0);
/** @param {Record<string, number> | undefined | null} map */
export const total = (map) => Object.values(map || {}).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);

/** The player whose turn it is, or null when the game is over. @param {any} state */
export const currentPlayer = (state) => {
    if (!state || state.gameOver) return null;
    return state.players?.[state.turnCounter] ?? null;
};

/** @param {any} state @param {string} name */
export const findPlayer = (state, name) => (state.players || []).find((/** @type {any} */ p) => p.name === name) ?? null;

/** @param {any} state @param {string} deck */
export const visibleCards = (state, deck) => /** @type {any[]} */ (state?.[deck]?.visibleCards ?? []);

/** Every visible development card on the board, with the deck it lies in. @param {any} state */
export const boardDevCards = (state) => DEV_DECKS.flatMap((deck) => visibleCards(state, deck).map((card) => ({ card, deck })));

/** The tier of a card, from cardTier or, failing that, its deck name. @param {any} card @param {string} [deck] */
export const tierOf = (card, deck) => {
    if (typeof card?.cardTier === "string") return card.cardTier;
    const m = deck?.match(/^tier(\d)/);
    return m ? `TIER_${m[1]}` : null;
};

/** Whether a gem colour (not Gold, not an unassigned Satchel). @param {unknown} t */
export const isGem = (t) => typeof t === "string" && /** @type {readonly string[]} */ (GEMS).includes(t);

/** Whether the player owns a development card with a gem bonus (needed before a Satchel card). @param {any} player */
export const ownsGemBonusCard = (player) => (player?.devCards || []).some((/** @type {any} */ c) => isGem(c.tokenType));

/** Whether a Satchel card still waits for its colour. @param {any} card */
export const isUnassignedSatchel = (card) => card?.tokenType === "Satchel";

/** How many gems one gold token pays for (Trading Posts power 3 makes it 2). @param {any} player */
export const goldValue = (player) => (player?.goldTokenWorthTwoTokens?.unlocked ? 2 : 1);

/** Whether Trading Posts power 2 is unlocked (2 of a colour plus 1 other). @param {any} player */
export const hasDoublePlusOne = (player) => !!player?.extraTokenAfterTakingSameColor?.unlocked;

/**
 * The exact payment for a development card, or null when the player cannot
 * afford it. Never overpays: gem tokens cover what the bonuses leave owed,
 * then gold tokens cover the rest, then gold bonuses (double-gold cards),
 * which the server spends on its own when the offered gold falls short.
 *
 * "Bonus"-cost cards (the Orient sacrifice cards) cost bonuses, never tokens:
 * the player must hold the bonuses, the offer is empty and the server burns
 * the cards.
 *
 * @param {any} card
 * @param {any} player
 * @returns {null | { tokens: Record<string, number>, spent: number, goldTokens: number, goldBonusesUsed: number, bonusCost: boolean }}
 */
export function paymentFor(card, player) {
    if (!card || !player) return null;
    if (isUnassignedSatchel(card) && !ownsGemBonusCard(player)) return null;
    const cost = card.tokenCost || {};
    const bonuses = player.bonuses || {};
    const tokens = player.tokens || {};
    if (card.costType === "Bonus") {
        for (const g of GEMS) if (amount(cost, g) > amount(bonuses, g)) return null;
        return { tokens: {}, spent: 0, goldTokens: 0, goldBonusesUsed: 0, bonusCost: true };
    }
    const gv = goldValue(player);
    /** @type {Record<string, number>} */
    const pay = {};
    let goldNeeded = 0;
    let spent = 0;
    for (const g of GEMS) {
        const owed = Math.max(0, amount(cost, g) - amount(bonuses, g));
        const use = Math.min(owed, amount(tokens, g));
        if (use > 0) pay[g] = use;
        spent += use;
        goldNeeded += Math.ceil((owed - use) / gv);
    }
    const goldTokens = Math.min(goldNeeded, amount(tokens, "Gold"));
    const goldBonusesUsed = goldNeeded - goldTokens;
    if (goldBonusesUsed > amount(bonuses, "Gold")) return null;
    if (goldTokens > 0) pay.Gold = goldTokens;
    spent += goldTokens;
    return { tokens: pay, spent, goldTokens, goldBonusesUsed, bonusCost: false };
}

/**
 * What a card still needs before the player can buy it, counting bonuses and
 * the tokens already held: per colour, plus the total after gold tokens.
 * @param {any} card @param {any} player
 * @returns {{ perColour: Record<string, number>, total: number, owedTotal: number }}
 */
export function shortfall(card, player) {
    /** @type {Record<string, number>} */
    const perColour = {};
    let sum = 0;
    let owedTotal = 0;
    for (const g of GEMS) {
        const owed = Math.max(0, amount(card.tokenCost, g) - amount(player.bonuses, g));
        owedTotal += owed;
        const missing = Math.max(0, owed - amount(player.tokens, g));
        perColour[g] = missing;
        sum += missing;
    }
    const goldCover = amount(player.tokens, "Gold") * goldValue(player) + amount(player.bonuses, "Gold");
    return { perColour, total: Math.max(0, sum - goldCover), owedTotal };
}

/** Remaining bonus need per colour for a bonus requirement (a noble). @param {any} requirement @param {any} player */
export const bonusGap = (requirement, player) => {
    /** @type {Record<string, number>} */
    const gap = {};
    for (const g of GEMS) gap[g] = Math.max(0, amount(requirement?.tokenCost, g) - amount(player?.bonuses, g));
    return gap;
};

/** @param {any} player @param {any} noble */
export const qualifiesForNoble = (player, noble) => total(bonusGap(noble, player)) === 0;

/** Nobles the player may receive now: visible ones and their own reserved ones. @param {any} state @param {any} player */
export const qualifiedNobles = (state, player) =>
    [...visibleCards(state, "nobleDeck"), ...(player.reservedNobles || [])].filter((n) => qualifiesForNoble(player, n));

/**
 * The colour that best meets a city's "same colour" requirement: the gem with
 * the most bonuses among those the city does not already ask for by colour
 * (CitiesGame.qualifiesCities). Gold never counts.
 * @param {any} city @param {any} player
 * @returns {{ colour: string | null, have: number }}
 */
export const sameColourBest = (city, player) => {
    let colour = null;
    let have = 0;
    for (const g of GEMS) {
        if (amount(city.tokenCost, g) > 0) continue;
        const b = amount(player.bonuses, g);
        if (b > have) { have = b; colour = g; }
    }
    return { colour, have };
};

/** @param {any} player @param {any} city */
export const qualifiesForCity = (player, city) => {
    if (amount(player, "prestigePoints") < amount(city, "prestigePoints")) return false;
    for (const g of GEMS) if (amount(player.bonuses, g) < amount(city.tokenCost, g)) return false;
    return sameColourBest(city, player).have >= amount(city, "numSameBonuses");
};

/** Visible cities the player qualifies for now. @param {any} state @param {any} player */
export const qualifiedCities = (state, player) => visibleCards(state, "citiesDeck").filter((c) => qualifiesForCity(player, c));

/** Whether the player has reached the end condition of their game version. @param {any} state @param {any} player */
export const reachedEndCondition = (state, player) => {
    if (isCitiesVersion(state.gameVersion)) return (player.cities || []).length > 0;
    const target = typeof state.prestigePointsToWin === "number" && state.prestigePointsToWin > 0 ? state.prestigePointsToWin : POINTS_TO_WIN;
    return amount(player, "prestigePoints") >= target;
};

/**
 * Winners by the official rule, from a final state: among the players who
 * reached the end condition, the most prestige wins; a tie goes to the fewest
 * development cards; players still tied share the win. Seat order.
 * @param {any} state
 * @returns {string[]}
 */
export function expectedWinners(state) {
    const candidates = (state.players || []).filter((/** @type {any} */ p) => reachedEndCondition(state, p));
    if (candidates.length === 0) return [];
    const most = Math.max(...candidates.map((/** @type {any} */ p) => amount(p, "prestigePoints")));
    const top = candidates.filter((/** @type {any} */ p) => amount(p, "prestigePoints") === most);
    const fewest = Math.min(...top.map((/** @type {any} */ p) => (p.devCards || []).length));
    return top.filter((/** @type {any} */ p) => (p.devCards || []).length === fewest).map((/** @type {any} */ p) => p.name);
}

/**
 * Every rule violation visible in one state, as human-readable strings (empty
 * when the state is consistent). `players` is the seat count the game started
 * with.
 *
 * Checked: token conservation per type (bank + every player = the supply),
 * no negative counts, at most 10 tokens and 3 reserved cards per player,
 * bonuses equal to the cards owned, prestige equal to cards plus nobles
 * (plus Trading Posts power points), no card in two places, a sane turn
 * pointer and pending-action list.
 *
 * @param {any} state
 * @param {{ players?: number }} [opts]
 * @returns {string[]}
 */
export function stateViolations(state, opts = {}) {
    /** @type {string[]} */
    const errors = [];
    const players = state.players || [];
    const n = opts.players ?? players.length;
    const supply = tokenSupply(n);
    for (const t of TOKEN_TYPES) {
        const bank = amount(state.tokens, t);
        if (bank < 0) errors.push(`bank holds ${bank} ${t}`);
        let sum = bank;
        for (const p of players) {
            const held = amount(p.tokens, t);
            if (held < 0) errors.push(`${p.name} holds ${held} ${t}`);
            sum += held;
        }
        if (sum !== supply[t]) errors.push(`${t} tokens are not conserved: bank ${bank} + players = ${sum}, expected ${supply[t]}`);
    }
    for (const p of players) {
        const held = total(p.tokens);
        if (held > MAX_TOKENS) errors.push(`${p.name} holds ${held} tokens (max ${MAX_TOKENS})`);
        const reserved = (p.reservedCards || []).length;
        if (reserved > MAX_RESERVED) errors.push(`${p.name} has ${reserved} reserved cards (max ${MAX_RESERVED})`);
        for (const t of [...GEMS, "Gold"]) {
            const fromCards = (p.devCards || []).filter((/** @type {any} */ c) => c.tokenType === t)
                .reduce((/** @type {number} */ s, /** @type {any} */ c) => s + amount(c, "bonus"), 0);
            const bonus = amount(p.bonuses, t);
            if (bonus !== fromCards) errors.push(`${p.name} has ${bonus} ${t} bonuses but owns cards worth ${fromCards}`);
        }
        const cardPoints = (p.devCards || []).reduce((/** @type {number} */ s, /** @type {any} */ c) => s + amount(c, "prestigePoints"), 0)
            + 3 * (p.nobleCards || []).length;
        let expected = cardPoints;
        if (isTradingPostsVersion(state.gameVersion)) {
            expected += p.addFivePrestigePoints?.isUsed ? 5 : 0;
            expected += amount(p.addPrestigePointsWithCoatsOfArms, "currentAddedPoints");
        }
        const pp = amount(p, "prestigePoints");
        if (pp !== expected) errors.push(`${p.name} has ${pp} prestige points but cards, nobles and powers give ${expected}`);
    }
    /** @type {Map<string, string>} */
    const seen = new Map();
    /** @param {any[]} cards @param {string} where */
    const place = (cards, where) => {
        for (const c of cards || []) {
            if (!c || typeof c.id !== "string") continue;
            const other = seen.get(c.id);
            if (other) errors.push(`card ${c.id} is both in ${other} and in ${where}`);
            else seen.set(c.id, where);
        }
    };
    for (const deck of [...DEV_DECKS, "nobleDeck", "citiesDeck"]) place(visibleCards(state, deck), deck);
    for (const p of players) {
        place(p.devCards, `${p.name}.devCards`);
        place(p.reservedCards, `${p.name}.reservedCards`);
        place(p.nobleCards, `${p.name}.nobleCards`);
        place(p.reservedNobles, `${p.name}.reservedNobles`);
        place(p.cities, `${p.name}.cities`);
    }
    if (state.gameOver) {
        if ((state.curValidActions || []).length) errors.push(`game over but curValidActions is ${JSON.stringify(state.curValidActions)}`);
    } else {
        if (!Number.isInteger(state.turnCounter) || state.turnCounter < 0 || state.turnCounter >= players.length) {
            errors.push(`turnCounter ${state.turnCounter} is not a seat of ${players.length} players`);
        }
        if (!(state.curValidActions || []).length) errors.push("the game is running but curValidActions is empty");
    }
    return errors;
}

/**
 * Violations in a freshly launched game: everything stateViolations checks,
 * plus the setup itself (full gem piles for the player count, 5 gold, nobles
 * dealt only when the version has them, 4 cards per regular tier, 2 per
 * Orient tier, 3 cities in Cities games, seat 0 to move with the main
 * actions).
 * @param {any} state @param {{ version?: string, players?: number }} [opts]
 * @returns {string[]}
 */
export function initialStateViolations(state, opts = {}) {
    const players = state.players || [];
    const n = opts.players ?? players.length;
    const version = opts.version ?? state.gameVersion;
    const errors = stateViolations(state, { players: n });
    if (players.length !== n) errors.push(`expected ${n} players, the state has ${players.length}`);
    if (opts.version && state.gameVersion && state.gameVersion !== opts.version) {
        errors.push(`expected game version ${opts.version}, the state says ${state.gameVersion}`);
    }
    for (const g of GEMS) {
        if (amount(state.tokens, g) !== gemsPerColour(n)) errors.push(`bank starts with ${amount(state.tokens, g)} ${g}, expected ${gemsPerColour(n)}`);
    }
    if (amount(state.tokens, "Gold") !== GOLD_TOKENS) errors.push(`bank starts with ${amount(state.tokens, "Gold")} Gold, expected ${GOLD_TOKENS}`);
    const nobles = visibleCards(state, "nobleDeck").length;
    const wantNobles = dealsNobles(version) ? n + 1 : 0;
    if (nobles !== wantNobles) errors.push(`${nobles} nobles dealt, expected ${wantNobles} for ${version} with ${n} players`);
    for (const deck of DEV_DECKS) {
        const want = deck.includes("Orient") ? 2 : 4;
        if (visibleCards(state, deck).length !== want) errors.push(`${deck} shows ${visibleCards(state, deck).length} cards, expected ${want}`);
    }
    if (isCitiesVersion(version) && visibleCards(state, "citiesDeck").length !== 3) {
        errors.push(`${visibleCards(state, "citiesDeck").length} cities dealt, expected 3`);
    }
    if (state.turnCounter !== 0) errors.push(`turnCounter starts at ${state.turnCounter}, expected 0`);
    const actions = [...(state.curValidActions || [])].sort().join(",");
    if (actions !== [...MAIN_ACTIONS].sort().join(",")) errors.push(`the game starts with actions ${actions}`);
    for (const p of players) {
        if (total(p.tokens) !== 0 || (p.devCards || []).length || (p.reservedCards || []).length || amount(p, "prestigePoints") !== 0) {
            errors.push(`${p.name} does not start empty`);
        }
    }
    return errors;
}

/**
 * Violations in a final state: game over, winners non-empty and matching the
 * official rule (see expectedWinners).
 * @param {any} state
 * @returns {string[]}
 */
export function finalStateViolations(state) {
    const errors = stateViolations(state);
    if (!state.gameOver) errors.push("the game is not over");
    const winners = (state.winners || []).map((/** @type {any} */ w) => w.name);
    if (winners.length === 0) errors.push("the game is over but nobody won");
    const expected = expectedWinners(state);
    const same = winners.length === expected.length && winners.every((/** @type {string} */ w) => expected.includes(w));
    if (!same) {
        const summary = (state.players || []).map((/** @type {any} */ p) =>
            `${p.name}: ${amount(p, "prestigePoints")} pts, ${(p.devCards || []).length} cards${isCitiesVersion(state.gameVersion) ? `, ${(p.cities || []).length} cities` : ""}`).join("; ");
        errors.push(`winners are ${JSON.stringify(winners)}, the rules say ${JSON.stringify(expected)} (${summary})`);
    }
    return errors;
}
