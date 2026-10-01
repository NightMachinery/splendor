// @ts-check
/**
 * The real card catalog, read from the server's own CSV resources and turned
 * into objects of exactly the shape the Game Service serialises (plain Gson
 * reflection over the model classes, null fields omitted):
 *
 *   RegDevelopmentCard  { tokenType, bonus, cardTier, id, prestigePoints, costType, tokenCost }
 *   OrientDevelopmentCard  adds { reserveNoble, isSatchel, cascadeType }
 *   NobleCard           { id, prestigePoints, costType: "Bonus", tokenCost }
 *   CityCard            { numSameBonuses, id, prestigePoints, costType: "Bonus", tokenCost }
 *
 * The parsing mirrors OrientGame.createSplendorBoard and
 * CitiesGame.createSplendorBoard (server/src/main/java/.../gameversions).
 * Fixtures built from this catalog therefore carry real ids (so card images
 * load), real costs and real Orient flags.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../e2e/lib/stack.mjs";

/** TokenType enum order (server model/TokenType.java). */
export const TOKEN_TYPES = ["Green", "White", "Blue", "Brown", "Red", "Satchel", "Gold"];
/** The five gem colours. */
export const GEMS = ["Green", "White", "Blue", "Brown", "Red"];
/** Column order of the CSV cost field ("W;Bl;G;R;Br"). */
const CSV_COST_ORDER = ["White", "Blue", "Green", "Red", "Brown"];

const RESOURCES = join(REPO_ROOT, "server", "src", "main", "resources");

/** @returns {Record<string, number>} a token map with every TokenType key at 0 */
export const emptyTokens = () => Object.fromEntries(TOKEN_TYPES.map((t) => [t, 0]));

/** @param {string} field */
const parseCost = (field) => {
    const parts = field.split(";");
    const cost = emptyTokens();
    CSV_COST_ORDER.forEach((t, i) => { cost[t] = Number(parts[i]); });
    return { cost, same: parts.length > 5 ? Number(parts[5]) : 0 };
};

/** @param {string} name */
const readCsv = (name) => readFileSync(join(RESOURCES, name), "utf8")
    .split(/\r?\n/).slice(1).filter((line) => line.trim() !== "")
    .map((line) => line.split(","));

/**
 * @typedef {Record<string, any>} Card
 */

/** @type {Map<string, Card>} */
const byId = new Map();
/** @type {Record<string, Card[]>} deck name -> cards in CSV order */
export const DECKS = {
    tier1Deck: [], tier2Deck: [], tier3Deck: [],
    tier1OrientDeck: [], tier2OrientDeck: [], tier3OrientDeck: [],
    nobleDeck: [], citiesDeck: [],
};

for (const c of readCsv("cards.csv")) {
    const [tokenType, bonus, prestige, costType, costField, kind, id, cascadeCol = "", reserveNobleCol = ""] = c;
    const base = { id, prestigePoints: Number(prestige), costType, tokenCost: parseCost(costField).cost };
    /** @type {Card} */
    let card;
    if (kind === "N") {
        card = base;
        DECKS.nobleDeck.push(card);
    } else if (kind === "1" || kind === "2" || kind === "3") {
        card = { tokenType, bonus: Number(bonus), cardTier: `TIER_${kind}`, ...base };
        DECKS[`tier${kind}Deck`].push(card);
    } else {
        const tier = kind.slice(1);
        let cascadeType = "None";
        let reserveNoble = false;
        if (kind === "O2" && cascadeCol.trim() !== "") cascadeType = "Tier1";
        else if (kind === "O2" && reserveNobleCol.trim() !== "") reserveNoble = true;
        if (kind === "O3" && cascadeCol.trim() !== "") cascadeType = "Tier2";
        card = {
            reserveNoble, isSatchel: tokenType === "Satchel", cascadeType,
            tokenType, bonus: Number(bonus), cardTier: `TIER_${tier}`, ...base,
        };
        DECKS[`tier${tier}OrientDeck`].push(card);
    }
    if (byId.has(id)) throw new Error(`duplicate card id ${id} in cards.csv`);
    byId.set(id, card);
}

for (const c of readCsv("citycards.csv")) {
    const [, , prestige, , costField, , id] = c;
    const { cost, same } = parseCost(costField);
    const city = { numSameBonuses: same, id, prestigePoints: Number(prestige), costType: "Bonus", tokenCost: cost };
    DECKS.citiesDeck.push(city);
    byId.set(id, city);
}

/**
 * A fresh deep copy of a catalog card (fixtures may mutate it, e.g. a satchel's tokenType).
 * @param {string} id
 * @returns {Card}
 */
export function card(id) {
    const c = byId.get(id);
    if (!c) throw new Error(`no card with id ${id} in the server catalog`);
    return structuredClone(c);
}

/** @param {(c: Card) => boolean} pred */
export const findCards = (pred) => [...byId.values()].filter(pred).map((c) => structuredClone(c));
