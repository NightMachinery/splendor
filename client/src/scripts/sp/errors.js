// @ts-check
/**
 * Player copy for Game Service errors (WP-RULES), DOM-free.
 *
 * The Game Service answers a refused action with HTTP 400 and a plain-text
 * message: an ActionResult description (model/action/ActionResult.java) or
 * the message of a SplendorException. mapServerError matches the trimmed
 * text by case-insensitive prefix (a few free-form messages that start with
 * a card id are matched by pattern), so small rewordings at the end of a
 * server message never break the mapping. See docs/ui/rules.md.
 */

/** Player copy by code. Codes are the server's ActionResult names where one exists. */
export const ERROR_COPY = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
    INVALID_PLAYER: "It's not your turn any more.",
    INVALID_TOKENS_GIVEN: "That gem combination isn't allowed: take 3 different colours, or 2 of one colour from a pile of 4 or more.",
    MAXIMUM_CARDS_RESERVED: "You already hold 3 reserved cards.",
    NOT_ENOUGH_TOKENS_ON_BOARD: "The bank doesn't have those gems any more.",
    MAXIMUM_TOKENS_IN_INVENTORY: "You can hold at most 10 gems. Return some.",
    NOT_ENOUGH_TOKENS_IN_INVENTORY: "You don't have those gems.",
    ACTION_NOT_ALLOWED: "That move isn't available right now.",
    GAME_OVER: "The game is over.",
    GOLD_CANNOT_BE_TAKEN: "Gold comes only from reserving a card.",
    TOO_MANY_TOKENS_RETURNED: "Return only enough gems to get back to 10.",
    PAYMENT_TOO_LOW: "That payment doesn't cover the cost.",
    PAYMENT_TOO_HIGH: "That's more than the card costs. Pay the exact amount.",
    NOT_ENOUGH_BONUSES: "You don't have enough cards of that colour to sacrifice.",
    PUT_BACK_NOT_ALLOWED: "You can return a gem only when reserving would give you an 11th.",
    INVALID_TOKEN_CHOSEN: "Pick a colour from your own cards.",
    TOKEN_MISMATCH: "Your sign-in doesn't match this seat. Reload the page.",
    // free-form server messages (SplendorException)
    MALFORMED: "The board sent a move the server couldn't read. Reload the page and try again.",
    CARD_GONE: "That card isn't on the table any more.",
    SATCHEL_NEEDS_GEM_CARD: "A satchel needs a coloured card to pair with.",
    SATCHEL_ALREADY_SET: "That satchel already has its colour.",
    CASCADE_WRONG_TIER: "Pick a card from the tier this free card comes from.",
    NOBLE_GONE: "That noble isn't on the table any more.",
    NOBLE_NOT_QUALIFIED: "You don't qualify for that noble.",
    CITY_GONE: "That city isn't on the table any more.",
    CITY_NOT_QUALIFIED: "You don't qualify for that city yet.",
    NO_CITIES: "This game has no cities.",
    SESSION_GONE: "This game isn't running any more. Go back to the lobby.",
    NOT_SEATED: "You're not seated in this game.",
    // transport
    NETWORK: "Couldn't reach the table. Check your connection and try again.",
    SERVER_ERROR: "The server hit a problem. Checking whether your move went through…",
    UNKNOWN: "The server refused that move.",
}));

/**
 * Matching rules, tried in order. A string matches as a case-insensitive
 * prefix of the trimmed message; a RegExp is tested as it is.
 * @type {ReadonlyArray<{ code: string, match: string | RegExp }>}
 */
export const ERROR_RULES = Object.freeze([
    { code: "INVALID_PLAYER", match: "It is not this players turn" },
    { code: "INVALID_TOKENS_GIVEN", match: "The tokens chosen are invalid" },
    { code: "MAXIMUM_CARDS_RESERVED", match: "You already have the maximum amount of reserved cards" },
    { code: "NOT_ENOUGH_TOKENS_ON_BOARD", match: "There are not enough tokens on the board" },
    { code: "MAXIMUM_TOKENS_IN_INVENTORY", match: "You would end up with more than 10 tokens" },
    { code: "NOT_ENOUGH_TOKENS_IN_INVENTORY", match: "You do not have enough tokens" },
    { code: "ACTION_NOT_ALLOWED", match: "This action is not allowed right now" },
    { code: "ACTION_NOT_ALLOWED", match: "Given action is not valid" },
    { code: "ACTION_NOT_ALLOWED", match: "Unknown action" },
    { code: "GAME_OVER", match: "The game is over" },
    { code: "GOLD_CANNOT_BE_TAKEN", match: "Gold cannot be taken" },
    { code: "TOO_MANY_TOKENS_RETURNED", match: "You may only return tokens to get back down to 10" },
    { code: "PAYMENT_TOO_LOW", match: "The tokens offered, together with your bonuses, do not cover" },
    { code: "PAYMENT_TOO_HIGH", match: "You offered more than this card costs" },
    { code: "NOT_ENOUGH_BONUSES", match: "You do not have the bonuses this card requires" },
    { code: "PUT_BACK_NOT_ALLOWED", match: "You can only return a token when reserving" },
    { code: "INVALID_TOKEN_CHOSEN", match: "Invalid token type chosen for assigning satchel" },
    { code: "TOKEN_MISMATCH", match: "Token does not match" },
    // malformed bodies: ActionDecoder wraps ActionJson errors in "Invalid data given for action X: ..."
    { code: "MALFORMED", match: "Invalid data given for action" },
    { code: "MALFORMED", match: "Missing request body" },
    { code: "MALFORMED", match: "The request body" },
    { code: "MALFORMED", match: "Missing field" },
    { code: "MALFORMED", match: "Field '" },
    { code: "MALFORMED", match: "Amount for '" },
    { code: "MALFORMED", match: "Unknown token type" },
    // cards, nobles and cities named by id
    { code: "CARD_GONE", match: /^card with id '.*' is (not a development card on the board|neither a development card)/i },
    { code: "SATCHEL_ALREADY_SET", match: /^card with id '.*' (does not exist is not|is not) of type satchel/i },
    { code: "SATCHEL_NEEDS_GEM_CARD", match: "Cannot purchase card with satchel bonus" },
    { code: "SATCHEL_NEEDS_GEM_CARD", match: /^card '.*' cannot be taken: a satchel card/i },
    { code: "CASCADE_WRONG_TIER", match: /^cascade_\d takes a /i },
    { code: "NOBLE_GONE", match: "Noble with id" },
    { code: "NOBLE_NOT_QUALIFIED", match: "Noble card with id" },
    { code: "CITY_GONE", match: /^city card with id '.*' is not on the board/i },
    { code: "CITY_NOT_QUALIFIED", match: /^city card with id '.*' cannot be chosen/i },
    { code: "NO_CITIES", match: "This game has no cities" },
    { code: "SESSION_GONE", match: "There is no session associated" },
    { code: "NOT_SEATED", match: "The specified player does not exist in this session" },
]);

/** Messages browsers put in the TypeError of a failed fetch. */
const NETWORK_TEXT = /^(failed to fetch|networkerror|load failed|network request failed|the network connection was lost)/i;

/**
 * Map a Game Service error to player copy.
 *   - status 0, or a browser's failed-fetch message: NETWORK;
 *   - status 500 and up: SERVER_ERROR (submit.js then checks whether the
 *     move went through before it shows anything final);
 *   - status 401: TOKEN_MISMATCH;
 *   - otherwise the first ERROR_RULES entry that matches, else UNKNOWN.
 * `raw` is the trimmed server text, to show below the copy in small type.
 * @param {unknown} text the response body (or an error message)
 * @param {number} [status] the HTTP status; 0 for a network failure
 * @returns {{ code: string, copy: string, raw: string }}
 */
export function mapServerError(text, status) {
    const raw = typeof text === "string" ? text.trim() : text == null ? "" : String(text).trim();
    /** @param {string} code */
    const out = (code) => ({ code, copy: ERROR_COPY[code] ?? ERROR_COPY.UNKNOWN, raw });
    if (status === 0 || NETWORK_TEXT.test(raw)) return out("NETWORK");
    if (typeof status === "number" && status >= 500) return out("SERVER_ERROR");
    if (status === 401) return out("TOKEN_MISMATCH");
    const lower = raw.toLowerCase();
    for (const rule of ERROR_RULES) {
        const hit = typeof rule.match === "string" ? lower.startsWith(rule.match.toLowerCase()) : rule.match.test(raw);
        if (hit) return out(rule.code);
    }
    return out("UNKNOWN");
}
