// @ts-check
/**
 * An offline model of the Splendor Game Service, for unit tests.
 *
 * It mirrors the rules of the server model as of October 2026
 * (server/src/main/java/ca/hexanome04/splendorgame/model: OrientGame,
 * CitiesGame, TradingPostsGame, OrientPlayer, Card.checkPayment and the
 * actions/* classes), on the real card catalog, and produces states in the
 * exact JSON shape GET /api/sessions/{id} returns. Hidden deck order is
 * seeded, so a game is reproducible.
 *
 * It exists so the bot and playGame can be exercised through whole games
 * with node --test, without a running stack. It is a test double, not a
 * second implementation of record: when the server's rules change, the e2e
 * suites against a real instance are the authority, and this file should be
 * brought in line.
 *
 * FakeApi wraps an Engine in the SplendorApi interface playGame uses.
 */
import { DECKS, GEMS, TOKEN_TYPES, emptyTokens } from "./cards.mjs";

/** A rule violation: answered with HTTP 400 and this message, like the server. */
export class RuleError extends Error {}

const MSG = {
    INVALID_PLAYER: "It is not this players turn.",
    INVALID_TOKENS_GIVEN: "The tokens chosen are invalid: take up to 3 gems of different colours, or 2 gems of one colour from a pile that holds at least 4.",
    INVALID_TOKEN_CHOSEN: "Invalid token type chosen for assigning satchel card bonus.",
    MAXIMUM_CARDS_RESERVED: "You already have the maximum amount of reserved cards!",
    NOT_ENOUGH_TOKENS_ON_BOARD: "There are not enough tokens on the board for you to take.",
    MAXIMUM_TOKENS_IN_INVENTORY: "You would end up with more than 10 tokens.",
    NOT_ENOUGH_TOKENS_IN_INVENTORY: "You do not have enough tokens in your inventory.",
    ACTION_NOT_ALLOWED: "This action is not allowed right now; see curValidActions in the game state.",
    GAME_OVER: "The game is over.",
    GOLD_CANNOT_BE_TAKEN: "Gold cannot be taken like a gem; you gain gold by reserving a card.",
    TOO_MANY_TOKENS_RETURNED: "You may only return tokens to get back down to 10.",
    PAYMENT_TOO_LOW: "The tokens offered, together with your bonuses, do not cover this card's cost.",
    PAYMENT_TOO_HIGH: "You offered more than this card costs after your bonuses; pay the exact amount.",
    NOT_ENOUGH_BONUSES: "You do not have the bonuses this card requires.",
    PUT_BACK_NOT_ALLOWED: "You can only return a token when reserving would give you an 11th token.",
};

const MAIN = ["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"];
const DEV_DECKS = ["tier1Deck", "tier2Deck", "tier3Deck", "tier1OrientDeck", "tier2OrientDeck", "tier3OrientDeck"];
const isGem = (/** @type {unknown} */ t) => typeof t === "string" && GEMS.includes(t);
const num = (/** @type {any} */ m, /** @type {string} */ k) => (m && typeof m[k] === "number" ? m[k] : 0);
const sum = (/** @type {any} */ m) => Object.values(m || {}).reduce((/** @type {number} */ s, v) => s + /** @type {number} */ (v), 0);
const isOrient = (/** @type {any} */ c) => c && "isSatchel" in c;
const isDevCard = (/** @type {any} */ c) => c && typeof c.cardTier === "string";

/** Seeded PRNG (mulberry32). @param {number} seed */
const prng = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** In-place Fisher-Yates, like Collections.shuffle. @param {any[]} list @param {() => number} rnd */
const shuffle = (list, rnd) => {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
};

const POWERS = {
    extraTokenAfterPurchase: { Red: 3, White: 1 },
    extraTokenAfterTakingSameColor: { White: 2 },
    goldTokenWorthTwoTokens: { Blue: 3, Brown: 1 },
    addFivePrestigePoints: { Green: 5 },
    addPrestigePointsWithCoatsOfArms: { Brown: 3 },
};

export class Engine {
    /**
     * @param {{ version?: string, players: string[], seed?: number, colours?: string[] }} opts
     */
    constructor({ version = "BASE_ORIENT", players, seed = 1, colours = [] }) {
        if (players.length < 2 || players.length > 4) throw new Error("2 to 4 players");
        this.version = version;
        this.cities = version === "BASE_ORIENT_CITIES" || version === "BASE_ORIENT_CITIES_NOBLES";
        this.tp = version === "BASE_ORIENT_TRADE_ROUTES";
        const rnd = prng(seed);
        /** @type {Record<string, any[]>} hidden stacks; the top is the end of the array */
        this.hidden = {};
        /** @type {any} */
        const s = {};
        if (this.cities) s.citiesDeck = { visibleCards: [], canDraw: false };
        Object.assign(s, {
            gameVersion: version,
            prestigePointsToWin: this.cities ? -1 : 15,
            turnCounter: 0,
            curValidActions: [...MAIN],
            players: players.map((name, i) => this.newPlayer(name, colours[i] ?? "1E90FF")),
        });
        for (const d of [...DEV_DECKS, "nobleDeck"]) s[d] = { visibleCards: [], canDraw: false };
        s.tokens = emptyTokens();
        s.playersWhoCanWin = [];
        s.winners = [];
        s.gameOver = false;
        s.nobleVisitedThisTurn = false;
        this.state = s;

        for (const d of [...DEV_DECKS, "nobleDeck", ...(this.cities ? ["citiesDeck"] : [])]) {
            this.hidden[d] = structuredClone(DECKS[d]);
            s[d].canDraw = this.hidden[d].length > 0;
        }
        for (const d of DEV_DECKS) shuffle(this.hidden[d], rnd);
        for (const d of ["tier1Deck", "tier2Deck", "tier3Deck"]) this.draw(d, 4);
        for (const d of ["tier1OrientDeck", "tier2OrientDeck", "tier3OrientDeck"]) this.draw(d, 2);
        shuffle(this.hidden.nobleDeck, rnd);
        if (version !== "BASE_ORIENT_CITIES") this.draw("nobleDeck", players.length + 1);
        const gems = { 2: 4, 3: 5, 4: 7 }[players.length] ?? 0;
        for (const t of TOKEN_TYPES) s.tokens[t] = gems;
        s.tokens.Satchel = 0;
        s.tokens.Gold = 5;
        if (this.cities) {
            shuffle(this.hidden.citiesDeck, rnd);
            this.draw("citiesDeck", 3);
        }
    }

    /** @param {string} name @param {string} colour */
    newPlayer(name, colour) {
        /** @type {any} */
        const p = {};
        if (this.tp) {
            p.coatsOfArmsUnplaced = 5;
            p.extraTokenAfterPurchase = { requirements: POWERS.extraTokenAfterPurchase, unlocked: false };
            p.extraTokenAfterTakingSameColor = { requirements: POWERS.extraTokenAfterTakingSameColor, unlocked: false };
            p.goldTokenWorthTwoTokens = { requirements: POWERS.goldTokenWorthTwoTokens, unlocked: false };
            p.addFivePrestigePoints = { isUsed: false, requirements: POWERS.addFivePrestigePoints, unlocked: false };
            p.addPrestigePointsWithCoatsOfArms = { currentAddedPoints: 0, requirements: POWERS.addPrestigePointsWithCoatsOfArms, unlocked: false };
        }
        if (this.cities) {
            p.cities = [];
            p.citiesQualifiedFor = [];
        }
        Object.assign(p, {
            name, colour, prestigePoints: 0, tokens: emptyTokens(), bonuses: emptyTokens(),
            devCards: [], nobleCards: [], reservedCards: [], reservedNobles: [],
        });
        return p;
    }

    /** The state as the GS would send it (a deep copy). */
    json() {
        return structuredClone(this.state);
    }

    /** The exact body text. */
    text() {
        return JSON.stringify(this.state);
    }

    // ------------------------------------------------------------ decks

    /** @param {string} deck @param {number} count */
    draw(deck, count) {
        for (let i = 0; i < count; i++) {
            const c = this.hidden[deck].pop();
            if (c) this.state[deck].visibleCards.push(c);
        }
        this.state[deck].canDraw = this.hidden[deck].length > 0;
    }

    /** OrientGame.getCardFromId (+ CitiesGame): visible cards of every deck. @param {unknown} id */
    cardOnBoard(id) {
        let found = null;
        for (const d of [...DEV_DECKS, "nobleDeck", ...(this.cities ? ["citiesDeck"] : [])]) {
            for (const c of this.state[d].visibleCards) if (c.id === id) found = { card: c, deck: d };
        }
        return found;
    }

    /** Deck.take: remove a visible card and refill dev decks. @param {string} deck @param {any} card */
    take(deck, card) {
        const list = this.state[deck].visibleCards;
        const i = list.indexOf(card);
        if (i < 0) return false;
        list.splice(i, 1);
        if (deck !== "nobleDeck" && deck !== "citiesDeck") this.draw(deck, 1);
        this.state[deck].canDraw = this.hidden[deck].length > 0;
        return true;
    }

    // ------------------------------------------------------------ helpers

    get current() {
        return this.state.gameOver ? null : this.state.players[this.state.turnCounter];
    }

    /** @param {any} p */
    ownsGemBonusCard(p) {
        return p.devCards.some((/** @type {any} */ c) => isGem(c.tokenType));
    }

    /** @param {any} p */
    hasUnassignedSatchel(p) {
        return p.devCards.some((/** @type {any} */ c) => c.tokenType === "Satchel");
    }

    /** @param {any} p @param {string} tier */
    cascadeChoices(p, tier) {
        const decks = tier === "TIER_1" ? ["tier1Deck", "tier1OrientDeck"] : tier === "TIER_2" ? ["tier2Deck", "tier2OrientDeck"] : [];
        let cards = decks.flatMap((d) => this.state[d].visibleCards);
        if (!this.ownsGemBonusCard(p)) cards = cards.filter((/** @type {any} */ c) => c.tokenType !== "Satchel");
        return cards;
    }

    /** @param {any} p */
    qualifiesForNoble(p) {
        return [...this.state.nobleDeck.visibleCards, ...p.reservedNobles]
            .filter((n) => GEMS.every((g) => num(n.tokenCost, g) <= num(p.bonuses, g)));
    }

    /** CitiesGame.qualifiesCities (records citiesQualifiedFor as a side effect, like the server). @param {any} p */
    qualifiesCities(p) {
        const out = [];
        for (const city of this.state.citiesDeck.visibleCards) {
            let ok = true;
            let maxSame = 0;
            for (const g of GEMS) {
                if (num(p.bonuses, g) > maxSame && num(city.tokenCost, g) === 0) maxSame = num(p.bonuses, g);
            }
            if (maxSame < city.numSameBonuses) ok = false;
            for (const g of GEMS) if (num(p.bonuses, g) < num(city.tokenCost, g)) ok = false;
            if (p.prestigePoints < city.prestigePoints) ok = false;
            if (ok) {
                out.push(city);
                if (!p.citiesQualifiedFor.some((/** @type {any} */ c) => c.id === city.id)) p.citiesQualifiedFor.push(structuredClone(city));
            }
        }
        return out;
    }

    /** @param {any} p */
    canPlayerWin(p) {
        return this.cities ? p.cities.length > 0 : p.prestigePoints >= this.state.prestigePointsToWin;
    }

    /** @param {string} a */
    addValidAction(a) {
        if (!this.state.curValidActions.includes(a)) this.state.curValidActions.push(a);
    }

    /** @param {string} a */
    removeValidAction(a) {
        const i = this.state.curValidActions.indexOf(a);
        if (i >= 0) this.state.curValidActions.splice(i, 1);
    }

    /** @param {any} map @param {Record<string, number>} delta @param {number} sign */
    static addTo(map, delta, sign) {
        for (const [k, v] of Object.entries(delta)) map[k] = num(map, k) + sign * v;
    }

    /** OrientGame.followUpsForAcquiredCard. @param {any} p @param {any} card */
    followUps(p, card) {
        const out = [];
        if (!isOrient(card)) return out;
        if (card.reserveNoble && this.state.nobleDeck.visibleCards.length) out.push("RESERVE_NOBLE");
        if (card.cascadeType === "Tier1" && this.cascadeChoices(p, "TIER_1").length) out.push("CASCADE_1");
        else if (card.cascadeType === "Tier2" && this.cascadeChoices(p, "TIER_2").length) out.push("CASCADE_2");
        if (card.tokenType === "Satchel") out.push("CHOOSE_SATCHEL_TOKEN");
        return out;
    }

    // ------------------------------------------------------------ actions

    /**
     * Apply an action like PUT .../players/{name}/actions/{action}.
     * @param {string} name @param {string} action @param {any} body
     * @returns {{ ok: boolean, status: number, text: string }}
     */
    act(name, action, body) {
        const before = JSON.stringify(this.state);
        const hidden = JSON.stringify(this.hidden);
        try {
            this.apply(name, action, body ?? {});
            return { ok: true, status: 200, text: "" };
        } catch (err) {
            // A rejected action changes nothing (the server checks before it mutates).
            this.state = JSON.parse(before);
            this.hidden = JSON.parse(hidden);
            if (err instanceof RuleError) return { ok: false, status: 400, text: err.message };
            throw err;
        }
    }

    /** @param {string} name @param {string} action @param {any} body */
    apply(name, action, body) {
        const s = this.state;
        if (s.gameOver) throw new RuleError(MSG.GAME_OVER);
        const p = s.players.find((/** @type {any} */ pl) => pl.name === name);
        if (!p || s.players.indexOf(p) !== s.turnCounter) throw new RuleError(MSG.INVALID_PLAYER);
        if (!s.curValidActions.includes(action)) throw new RuleError(MSG.ACTION_NOT_ALLOWED);
        const handler = /** @type {any} */ (this)[`do_${action}`];
        if (!handler) throw new RuleError(`Unknown action ${action}`);
        /** @type {string[]} */
        const followUps = handler.call(this, p, body) || [];
        for (const f of followUps) this.addValidAction(f);
        this.removeImpossibleFollowUps(p);
        if (s.curValidActions.length === 0) this.endOfTurnChecks(p);
        if (s.curValidActions.length === 0) this.finishTurn();
    }

    /** @param {any} p */
    removeImpossibleFollowUps(p) {
        const s = this.state;
        if (s.curValidActions.includes("RESERVE_NOBLE") && !s.nobleDeck.visibleCards.length) this.removeValidAction("RESERVE_NOBLE");
        if (s.curValidActions.includes("CASCADE_1") && !this.cascadeChoices(p, "TIER_1").length) this.removeValidAction("CASCADE_1");
        if (s.curValidActions.includes("CASCADE_2") && !this.cascadeChoices(p, "TIER_2").length) this.removeValidAction("CASCADE_2");
        if (s.curValidActions.includes("CHOOSE_SATCHEL_TOKEN") && (!this.hasUnassignedSatchel(p) || !this.ownsGemBonusCard(p))) {
            this.removeValidAction("CHOOSE_SATCHEL_TOKEN");
        }
        if (s.curValidActions.includes("CHOOSE_NOBLE") && !this.qualifiesForNoble(p).length) this.removeValidAction("CHOOSE_NOBLE");
        if (this.cities && s.curValidActions.includes("CHOOSE_CITY") && !this.qualifiesCities(p).length) this.removeValidAction("CHOOSE_CITY");
    }

    /** @param {any} p */
    endOfTurnChecks(p) {
        const s = this.state;
        if (!s.nobleVisitedThisTurn) {
            const nobles = this.qualifiesForNoble(p);
            if (nobles.length === 1) this.grantNoble(p, nobles[0]);
            else if (nobles.length > 1) {
                this.addValidAction("CHOOSE_NOBLE");
                return;
            }
        }
        if (this.tp) this.tradingPostsChecks(p);
        if (this.cities && p.cities.length === 0) {
            const cities = this.qualifiesCities(p);
            if (cities.length === 1) {
                this.take("citiesDeck", cities[0]);
                p.cities.push(cities[0]);
            } else if (cities.length > 1) {
                this.addValidAction("CHOOSE_CITY");
            }
        }
        if (s.curValidActions.length === 0 && this.canPlayerWin(p) && !s.playersWhoCanWin.some((/** @type {any} */ w) => w.name === p.name)) {
            s.playersWhoCanWin.push(p);
        }
    }

    /** TradingPostsGame.expansionEndOfTurnChecks. @param {any} p */
    tradingPostsChecks(p) {
        const has = (/** @type {Record<string, number>} */ req) => Object.entries(req).every(([k, v]) => num(p.bonuses, k) >= v);
        const unlock = (/** @type {string} */ key) => {
            p[key].unlocked = true;
            p.coatsOfArmsUnplaced--;
            if (p.addPrestigePointsWithCoatsOfArms.unlocked) this.coatsOfArmsPoints(p);
        };
        for (const key of ["extraTokenAfterPurchase", "extraTokenAfterTakingSameColor", "goldTokenWorthTwoTokens"]) {
            if (!p[key].unlocked && has(/** @type {any} */ (POWERS)[key])) unlock(key);
        }
        if (!p.addFivePrestigePoints.unlocked && has(POWERS.addFivePrestigePoints) && p.nobleCards.length > 0) {
            unlock("addFivePrestigePoints");
            if (!p.addFivePrestigePoints.isUsed) {
                p.prestigePoints += 5;
                p.addFivePrestigePoints.isUsed = true;
            }
        }
        if (!p.addPrestigePointsWithCoatsOfArms.unlocked && has(POWERS.addPrestigePointsWithCoatsOfArms)) unlock("addPrestigePointsWithCoatsOfArms");
    }

    /** @param {any} p */
    coatsOfArmsPoints(p) {
        const placed = 5 - p.coatsOfArmsUnplaced;
        const power = p.addPrestigePointsWithCoatsOfArms;
        if (placed > power.currentAddedPoints) {
            p.prestigePoints += placed - power.currentAddedPoints;
            power.currentAddedPoints = placed;
        }
    }

    finishTurn() {
        const s = this.state;
        const n = s.players.length;
        if (s.turnCounter === n - 1) {
            const candidates = s.players.filter((/** @type {any} */ p) => this.canPlayerWin(p));
            if (candidates.length) {
                const most = Math.max(...candidates.map((/** @type {any} */ p) => p.prestigePoints));
                const top = candidates.filter((/** @type {any} */ p) => p.prestigePoints === most);
                const fewest = Math.min(...top.map((/** @type {any} */ p) => p.devCards.length));
                s.winners = top.filter((/** @type {any} */ p) => p.devCards.length === fewest);
                s.gameOver = true;
                s.turnCounter = -10000;
                s.curValidActions = [];
                return;
            }
        }
        s.turnCounter = s.turnCounter === n - 1 ? 0 : s.turnCounter + 1;
        s.curValidActions = [...MAIN];
        s.nobleVisitedThisTurn = false;
    }

    /** @param {any} p @param {any} noble */
    grantNoble(p, noble) {
        const i = p.reservedNobles.indexOf(noble);
        if (i >= 0) p.reservedNobles.splice(i, 1);
        else this.take("nobleDeck", noble);
        p.nobleCards.push(noble);
        p.prestigePoints += 3;
        this.state.nobleVisitedThisTurn = true;
    }

    /** ActionJson.tokenAmounts. @param {any} body @param {string} key @param {boolean} required */
    static amounts(body, key, required) {
        const v = body?.[key];
        if (v === undefined || v === null) {
            if (required) throw new RuleError(`Missing field '${key}'.`);
            return {};
        }
        if (typeof v !== "object" || Array.isArray(v)) throw new RuleError(`Field '${key}' must be an object such as {"Red": 1}.`);
        /** @type {Record<string, number>} */
        const out = {};
        for (const [t, a] of Object.entries(v)) {
            if (!TOKEN_TYPES.includes(t)) throw new RuleError(`Unknown token type '${t}' in field '${key}'.`);
            if (typeof a !== "number" || !Number.isInteger(a)) throw new RuleError(`Amount for '${key}.${t}' must be a whole number.`);
            if (a < 0) throw new RuleError(`Amount for '${key}.${t}' must not be negative.`);
            if (a > 100) throw new RuleError(`Amount for '${key}.${t}' is too large.`);
            out[t] = a;
        }
        return out;
    }

    /** @param {any} body @param {string} key */
    static string(body, key) {
        const v = body?.[key];
        if (v === undefined || v === null) throw new RuleError(`Missing field '${key}'.`);
        if (typeof v !== "string" || !v.trim()) throw new RuleError(`Field '${key}' must be a non-empty string.`);
        return v;
    }

    /** @param {any} body @param {string} key */
    static optionalToken(body, key) {
        const v = body?.[key];
        if (v === undefined || v === null) return null;
        if (typeof v !== "string" || !TOKEN_TYPES.includes(v)) throw new RuleError(`Unknown token type '${v}' in field '${key}'.`);
        return v;
    }

    /** TakeTokenAction. @param {any} p @param {any} body */
    do_TAKE_TOKEN(p, body) {
        const s = this.state;
        const take = Engine.amounts(body, "takeTokens", true);
        const back = Engine.amounts(body, "putBackTokens", false);
        for (const [t, a] of Object.entries(take)) if (!isGem(t) && a > 0) throw new RuleError(MSG.GOLD_CANNOT_BE_TAKEN);
        for (const [t, a] of Object.entries(back)) if (t === "Satchel" && a > 0) throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
        let held = 0;
        let taken = 0;
        let returned = 0;
        for (const t of TOKEN_TYPES) {
            const tk = num(take, t);
            const pb = num(back, t);
            const have = num(p.tokens, t);
            held += have;
            taken += tk;
            returned += pb;
            if (tk === 0 && pb === 0) continue;
            if (num(s.tokens, t) < tk) throw new RuleError(MSG.NOT_ENOUGH_TOKENS_ON_BOARD);
            if (pb > have + tk) throw new RuleError(MSG.NOT_ENOUGH_TOKENS_IN_INVENTORY);
        }
        const after = held + taken - returned;
        if (after > 10) throw new RuleError(MSG.MAXIMUM_TOKENS_IN_INVENTORY);
        if (returned > 0 && after < 10) throw new RuleError(MSG.TOO_MANY_TOKENS_RETURNED);
        let unique = 0;
        let double = 0;
        for (const [t, a] of Object.entries(take)) {
            if (a > 2) throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
            if (a === 2) {
                double++;
                if (num(s.tokens, t) < 4) throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
            } else if (a === 1) unique++;
        }
        if (this.tp && p.extraTokenAfterTakingSameColor.unlocked) {
            if (double > 1 || unique > 3 || (unique > 1 && double === 1)) throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
        } else if (double > 1 || unique > 3 || (unique > 0 && double > 0)) {
            throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
        }
        Engine.addTo(s.tokens, take, -1);
        Engine.addTo(s.tokens, back, +1);
        Engine.addTo(p.tokens, take, +1);
        Engine.addTo(p.tokens, back, -1);
        s.curValidActions = [];
        return [];
    }

    /** Card.checkPayment. @param {any} card @param {any} p @param {Record<string, number>} offered */
    checkPayment(card, p, offered) {
        for (const [t, a] of Object.entries(offered)) {
            if (a < 0 || (t === "Satchel" && a > 0)) throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
        }
        for (const [t, a] of Object.entries(offered)) if (num(p.tokens, t) - a < 0) throw new RuleError(MSG.NOT_ENOUGH_TOKENS_IN_INVENTORY);
        if (card.costType === "Bonus") {
            if (sum(offered) > 0) throw new RuleError(MSG.PAYMENT_TOO_HIGH);
            for (const g of GEMS) if (num(card.tokenCost, g) > num(p.bonuses, g)) throw new RuleError(MSG.NOT_ENOUGH_BONUSES);
            return { goldBonusesToRemove: 0, goldCardsToDiscard: 0 };
        }
        const gv = this.tp && p.goldTokenWorthTwoTokens.unlocked ? 2 : 1;
        let goldNeeded = 0;
        for (const g of GEMS) {
            const owed = Math.max(0, num(card.tokenCost, g) - num(p.bonuses, g));
            const paid = num(offered, g);
            if (paid > owed) throw new RuleError(MSG.PAYMENT_TOO_HIGH);
            goldNeeded += Math.ceil((owed - paid) / gv);
        }
        const goldOffered = num(offered, "Gold");
        if (goldOffered > goldNeeded) throw new RuleError(MSG.PAYMENT_TOO_HIGH);
        const used = goldNeeded - goldOffered;
        const owned = num(p.bonuses, "Gold");
        if (used > owned) throw new RuleError(MSG.PAYMENT_TOO_LOW);
        const cards = Math.ceil(used / 2);
        return { goldBonusesToRemove: Math.min(owned, cards * 2), goldCardsToDiscard: cards };
    }

    /** OrientPlayer.burnBonuses / findOptimizedBurn. @param {any} p @param {Record<string, number>} cost */
    burn(p, cost) {
        const type = GEMS.find((g) => num(cost, g) > 0);
        if (!type) return;
        const singles = [];
        let lowestDouble = null;
        for (const c of p.devCards) {
            if (c.tokenType !== type) continue;
            if (c.bonus === 2) {
                if (!lowestDouble || c.prestigePoints < lowestDouble.prestigePoints) lowestDouble = c;
            } else if (c.bonus === 1) singles.push(c);
        }
        const sat = (/** @type {any} */ c) => !!(isOrient(c) && c.isSatchel);
        singles.sort((a, b) => (sat(a) !== sat(b) ? (sat(a) ? -1 : 1) : a.prestigePoints - b.prestigePoints));
        let remove = [];
        if (singles.length < 2) remove = lowestDouble ? [lowestDouble] : [];
        else if (!lowestDouble || sat(singles[0])) remove = singles.slice(0, 2);
        else remove = singles[0].prestigePoints + singles[1].prestigePoints > lowestDouble.prestigePoints ? [lowestDouble] : singles.slice(0, 2);
        for (const c of remove) {
            p.devCards.splice(p.devCards.indexOf(c), 1);
            p.bonuses[c.tokenType] -= c.bonus;
            p.prestigePoints -= c.prestigePoints;
        }
    }

    /** BuyCardAction. @param {any} p @param {any} body */
    do_BUY_CARD(p, body) {
        const s = this.state;
        const id = Engine.string(body, "cardId");
        const offered = Engine.amounts(body, "tokens", true);
        const onBoard = this.cardOnBoard(id);
        let card = onBoard && isDevCard(onBoard.card) ? onBoard.card : null;
        let reserved = false;
        if (!card) {
            card = p.reservedCards.find((/** @type {any} */ c) => c.id === id) ?? null;
            reserved = !!card;
        }
        if (!card) throw new RuleError(`Card with id '${id}' is neither a development card on the board nor one of your reserved cards.`);
        if (card.tokenType === "Satchel" && !this.ownsGemBonusCard(p)) {
            throw new RuleError("Cannot purchase card with satchel bonus without having another purchased card with a bonus.");
        }
        const pay = this.checkPayment(card, p, offered);
        Engine.addTo(p.tokens, offered, -1);
        Engine.addTo(s.tokens, Object.fromEntries(Object.entries(offered).filter(([, a]) => a > 0)), +1);
        if (pay.goldBonusesToRemove > 0) p.bonuses.Gold -= pay.goldBonusesToRemove;
        for (let i = 0; i < pay.goldCardsToDiscard; i++) {
            const j = p.devCards.findIndex((/** @type {any} */ c) => c.tokenType === "Gold");
            if (j >= 0) p.devCards.splice(j, 1);
        }
        p.devCards.push(card);
        if (reserved) p.reservedCards.splice(p.reservedCards.indexOf(card), 1);
        else this.take(/** @type {any} */ (onBoard).deck, card);
        if (card.tokenType !== "Satchel") p.bonuses[card.tokenType] = num(p.bonuses, card.tokenType) + card.bonus;
        p.prestigePoints += card.prestigePoints;
        if (isOrient(card) && card.costType === "Bonus") this.burn(p, card.tokenCost);
        const follow = this.followUps(p, card);
        if (this.tp && p.extraTokenAfterPurchase.unlocked) follow.push("TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER");
        s.curValidActions = [];
        return follow;
    }

    /** ReserveCardAction. @param {any} p @param {any} body */
    do_RESERVE_CARD(p, body) {
        const s = this.state;
        const id = Engine.string(body, "cardId");
        const putBack = Engine.optionalToken(body, "putBackToken");
        const onBoard = this.cardOnBoard(id);
        if (!onBoard || !isDevCard(onBoard.card)) throw new RuleError(`Card with id '${id}' is not a development card on the board.`);
        if (p.reservedCards.length >= 3) throw new RuleError(MSG.MAXIMUM_CARDS_RESERVED);
        const held = sum(p.tokens);
        const goldAvailable = num(s.tokens, "Gold") > 0;
        if (putBack !== null) {
            if (putBack === "Satchel") throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
            if (!goldAvailable || held < 10) throw new RuleError(MSG.PUT_BACK_NOT_ALLOWED);
            if (putBack !== "Gold" && num(p.tokens, putBack) < 1) throw new RuleError(MSG.NOT_ENOUGH_TOKENS_IN_INVENTORY);
        }
        this.take(onBoard.deck, onBoard.card);
        p.reservedCards.push(onBoard.card);
        if (goldAvailable && (held < 10 || putBack !== null)) {
            s.tokens.Gold--;
            p.tokens.Gold++;
            if (putBack !== null) {
                p.tokens[putBack]--;
                s.tokens[putBack]++;
            }
        }
        s.curValidActions = [];
        return [];
    }

    /** CascadeAction. @param {any} p @param {any} body @param {string} action @param {string} tier */
    cascade(p, body, action, tier) {
        const id = Engine.string(body, "cardId");
        const onBoard = this.cardOnBoard(id);
        if (!onBoard || !isDevCard(onBoard.card)) throw new RuleError(`Card with id '${id}' is not a development card on the board.`);
        const card = onBoard.card;
        if (card.cardTier !== tier) throw new RuleError(`${action} takes a ${tier} card, but card '${id}' is a ${card.cardTier} card.`);
        if (!this.cascadeChoices(p, tier).includes(card)) throw new RuleError(`Card '${id}' cannot be taken: a Satchel card needs another card with a gem bonus.`);
        p.devCards.push(card);
        this.take(onBoard.deck, card);
        if (card.tokenType !== "Satchel") p.bonuses[card.tokenType] = num(p.bonuses, card.tokenType) + card.bonus;
        p.prestigePoints += card.prestigePoints;
        const follow = this.followUps(p, card);
        this.removeValidAction(action);
        return follow;
    }

    /** @param {any} p @param {any} body */
    do_CASCADE_1(p, body) { return this.cascade(p, body, "CASCADE_1", "TIER_1"); }

    /** @param {any} p @param {any} body */
    do_CASCADE_2(p, body) { return this.cascade(p, body, "CASCADE_2", "TIER_2"); }

    /** ChooseTokenTypeAction. @param {any} p @param {any} body */
    do_CHOOSE_SATCHEL_TOKEN(p, body) {
        const id = Engine.string(body, "cardId");
        const selected = Engine.optionalToken(body, "selected");
        if (selected === null) throw new RuleError("Missing field 'selected'.");
        const card = p.devCards.find((/** @type {any} */ c) => c.id === id);
        if (!card || !isOrient(card)) throw new RuleError(`Card with id '${id}' does not exist is not of type Satchel.`);
        if (card.tokenType !== "Satchel") throw new RuleError(`Card with id '${id}' is not of type Satchel.`);
        if (!isGem(selected)) throw new RuleError(MSG.INVALID_TOKEN_CHOSEN);
        if (!p.devCards.some((/** @type {any} */ c) => c.tokenType === selected)) throw new RuleError(MSG.INVALID_TOKEN_CHOSEN);
        card.tokenType = selected;
        p.bonuses[selected] += 1;
        if (!this.hasUnassignedSatchel(p)) this.removeValidAction("CHOOSE_SATCHEL_TOKEN");
        return [];
    }

    /** ReserveNobleAction. @param {any} p @param {any} body */
    do_RESERVE_NOBLE(p, body) {
        const id = Engine.string(body, "cardId");
        const noble = this.state.nobleDeck.visibleCards.find((/** @type {any} */ n) => n.id === id);
        if (!noble) throw new RuleError(`Noble with id '${id}' is not on the board.`);
        this.take("nobleDeck", noble);
        p.reservedNobles.push(noble);
        this.removeValidAction("RESERVE_NOBLE");
        return [];
    }

    /** ChooseNobleAction. @param {any} p @param {any} body */
    do_CHOOSE_NOBLE(p, body) {
        const id = Engine.string(body, "cardId");
        const noble = this.qualifiesForNoble(p).find((n) => n.id === id);
        if (!noble) throw new RuleError(`Noble card with id '${id}' does not exist or you do not qualify for it.`);
        this.grantNoble(p, noble);
        this.removeValidAction("CHOOSE_NOBLE");
        return [];
    }

    /** ChooseCityAction. @param {any} p @param {any} body */
    do_CHOOSE_CITY(p, body) {
        if (!this.cities) throw new RuleError("This game has no cities.");
        const id = Engine.string(body, "cityId");
        const city = this.state.citiesDeck.visibleCards.find((/** @type {any} */ c) => c.id === id);
        if (!city) throw new RuleError(`City card with id '${id}' is not on the board.`);
        if (!this.qualifiesCities(p).includes(city)) throw new RuleError(`City card with id '${id}' cannot be chosen: you do not qualify for it.`);
        this.take("citiesDeck", city);
        p.cities.push(city);
        this.removeValidAction("CHOOSE_CITY");
        return [];
    }

    /** TakeExtraTokenAfterPurchasePowerAction. @param {any} p @param {any} body */
    do_TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER(p, body) {
        const s = this.state;
        const take = Engine.optionalToken(body, "takeToken");
        const back = Engine.optionalToken(body, "putBackToken");
        if (take !== null && !isGem(take)) throw new RuleError(MSG.GOLD_CANNOT_BE_TAKEN);
        if (back === "Satchel") throw new RuleError(MSG.INVALID_TOKENS_GIVEN);
        const done = () => { this.removeValidAction("TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"); return []; };
        if (take === null && back === null) return done();
        if (take === null) throw new RuleError(MSG.PUT_BACK_NOT_ALLOWED);
        if (num(s.tokens, take) < 1) throw new RuleError(MSG.NOT_ENOUGH_TOKENS_ON_BOARD);
        let after = sum(p.tokens) + 1;
        if (back !== null) {
            if (after <= 10) throw new RuleError(MSG.TOO_MANY_TOKENS_RETURNED);
            if (num(p.tokens, back) + (back === take ? 1 : 0) < 1) throw new RuleError(MSG.NOT_ENOUGH_TOKENS_IN_INVENTORY);
            after--;
        }
        if (after > 10) throw new RuleError(MSG.MAXIMUM_TOKENS_IN_INVENTORY);
        s.tokens[take]--;
        p.tokens[take]++;
        if (back !== null) {
            p.tokens[back]--;
            s.tokens[back]++;
        }
        return done();
    }
}

/**
 * The SplendorApi surface playGame uses, served by in-memory engines. Users
 * are created on the fly; tokens map to usernames like the LS does.
 */
export class FakeApi {
    /** @param {{ seed?: number }} [opts] */
    constructor({ seed = 1 } = {}) {
        this.seed = seed;
        /** @type {Map<string, Engine>} */
        this.games = new Map();
        /** @type {Map<string, string>} token -> username */
        this.tokens = new Map();
        this.nextId = 1000;
        /** @type {Array<{ sessionId: string, player: string, action: string, body: unknown, status: number }>} */
        this.calls = [];
    }

    /** @param {number} count @param {string} [prefix] */
    async createUsers(count, prefix = "Bot") {
        const users = [];
        for (let i = 1; i <= count; i++) {
            const username = `${prefix} ${i}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const token = `token-${username}`;
            this.tokens.set(token, username);
            users.push({ username, token, displayName: `${prefix} ${i}` });
        }
        return users;
    }

    /** @param {{ users: Array<{ username: string }>, version: string }} opts */
    async createGame({ users, version }) {
        const id = String(this.nextId++);
        this.games.set(id, new Engine({ version, players: users.map((u) => u.username), seed: this.seed + Number(id) }));
        return id;
    }

    /** @param {string} id */
    engine(id) {
        const e = this.games.get(id);
        if (!e) throw new Error(`no session ${id}`);
        return e;
    }

    /** @param {string} id */
    async getState(id) {
        return this.engine(id).json();
    }

    /** @param {string} id */
    async getStateText(id) {
        return { status: 200, ok: true, text: this.engine(id).text() };
    }

    /** @param {string} id @param {any} before */
    async waitForChange(id, before) {
        const now = this.engine(id).json();
        if (JSON.stringify(now) === JSON.stringify(before)) throw new Error("state did not change");
        return now;
    }

    /** @param {{ username: string, token: string }} user @param {string} id @param {string} action @param {unknown} body */
    async putAction(user, id, action, body) {
        if (this.tokens.get(user.token) !== user.username) return { ok: false, status: 401, text: "Token does not match requested players name." };
        const res = this.engine(id).act(user.username, action, JSON.parse(JSON.stringify(body ?? {})));
        this.calls.push({ sessionId: id, player: user.username, action, body, status: res.status });
        return res;
    }
}
