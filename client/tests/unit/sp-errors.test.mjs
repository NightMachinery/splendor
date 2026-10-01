// Unit tests for the Game Service error copy (src/scripts/sp/errors.js): the
// prefix table of the design, every message the offline engine raises, and
// the real server's own variants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapServerError, ERROR_COPY } from "../../src/scripts/sp/errors.js";
import { Engine } from "../fixtures/engine.mjs";
import { game, player, card, tokens } from "../fixtures/states.mjs";

test("the design's prefix table, word for word", () => {
    const table = [
        ["It is not this players turn.", "It's not your turn any more."],
        ["The tokens chosen are invalid: take up to 3 gems of different colours, or 2 gems of one colour from a pile that holds at least 4.",
            "That gem combination isn't allowed: take 3 different colours, or 2 of one colour from a pile of 4 or more."],
        ["You already have the maximum amount of reserved cards!", "You already hold 3 reserved cards."],
        ["There are not enough tokens on the board for you to take.", "The bank doesn't have those gems any more."],
        ["You would end up with more than 10 tokens.", "You can hold at most 10 gems. Return some."],
        ["You do not have enough tokens in your inventory.", "You don't have those gems."],
        ["This action is not allowed right now; see curValidActions in the game state.", "That move isn't available right now."],
        ["Given action is not valid: BUY_CARD", "That move isn't available right now."],
        ["The game is over.", "The game is over."],
        ["Gold cannot be taken like a gem; you gain gold by reserving a card.", "Gold comes only from reserving a card."],
        ["You may only return tokens to get back down to 10.", "Return only enough gems to get back to 10."],
        ["The tokens offered, together with your bonuses, do not cover this card's cost.", "That payment doesn't cover the cost."],
        ["You offered more than this card costs after your bonuses; pay the exact amount.", "That's more than the card costs. Pay the exact amount."],
        ["You do not have the bonuses this card requires.", "You don't have enough cards of that colour to sacrifice."],
        ["You can only return a token when reserving would give you an 11th token.", "You can return a gem only when reserving would give you an 11th."],
        ["Invalid token type chosen for assigning satchel card bonus.", "Pick a colour from your own cards."],
        ["Something nobody expected.", "The server refused that move."],
    ];
    for (const [text, copy] of table) {
        const m = mapServerError(text, 400);
        assert.equal(m.copy, copy, text);
        assert.equal(m.raw, text);
    }
    assert.equal(mapServerError("Token does not match requested players name.", 401).copy, "Your sign-in doesn't match this seat. Reload the page.");
});

test("matching ignores case and surrounding space, and keeps the raw text", () => {
    const m = mapServerError("  it is NOT this players turn.\n", 400);
    assert.equal(m.code, "INVALID_PLAYER");
    assert.equal(m.raw, "it is NOT this players turn.");
    assert.equal(mapServerError(undefined, 400).code, "UNKNOWN");
    assert.equal(mapServerError(null).raw, "");
    assert.equal(mapServerError({ toString: () => "The game is over." }).code, "GAME_OVER");
    assert.equal(mapServerError("Some message that merely mentions It is not this players turn", 400).code, "UNKNOWN", "a prefix, not a substring");
});

test("the real server's wordings and transport failures", () => {
    const real = {
        "You would end up with more than 10 tokens. Return tokens (putBackTokens) to get back down to 10.": "MAXIMUM_TOKENS_IN_INVENTORY",
        "Invalid data given for action BUY_CARD: Missing field 'cardId'.": "MALFORMED",
        "Invalid data given for action TAKE_TOKEN: Unknown token type 'Ruby' in field 'takeTokens'. Valid types: Green, White": "MALFORMED",
        "Invalid data given for action RESERVE_CARD.": "MALFORMED",
        "Missing request body for action TAKE_TOKEN.": "MALFORMED",
        "The request body is not valid JSON.": "MALFORMED",
        "CASCADE_2 takes a tier 2 card, but card '071' is a tier 3 card.": "CASCADE_WRONG_TIER",
        "There is no session associated this session ID: 123.": "SESSION_GONE",
        "The specified player does not exist in this session.": "NOT_SEATED",
        "Given action is not valid: CASCADE_1": "ACTION_NOT_ALLOWED",
    };
    for (const [text, code] of Object.entries(real)) assert.equal(mapServerError(text, 400).code, code, text);
    assert.equal(mapServerError("Server ran into an issue while executing an action.", 500).code, "SERVER_ERROR");
    assert.equal(mapServerError("", 503).copy, "The server hit a problem. Checking whether your move went through…");
    assert.equal(mapServerError("Failed to fetch", 0).copy, "Couldn't reach the table. Check your connection and try again.");
    assert.equal(mapServerError("TypeError: whatever", 0).code, "NETWORK");
    assert.equal(mapServerError("NetworkError when attempting to fetch resource.").code, "NETWORK");
    assert.equal(mapServerError("Load failed").code, "NETWORK");
    assert.equal(mapServerError("Not logged in.", 401).code, "TOKEN_MISMATCH");
    for (const code of Object.keys(ERROR_COPY)) assert.ok(ERROR_COPY[code].length > 0);
});

// ------------------------------------------------------------ every engine message

/** Run one action on an engine and return its 400 text. */
const refusal = (e, name, action, body) => {
    const res = e.act(name, action, body);
    assert.equal(res.status, 400, `${action} ${JSON.stringify(body)} was accepted`);
    return res.text;
};

/** Engines on fixture states. */
const base = (opts = {}) => {
    const s = game(opts);
    const e = new Engine({ version: s.gameVersion, players: s.players.map((p) => p.name) });
    e.state = s;
    return e;
};

/** [label, () => refusal text, expected code] for every way the engine refuses an action. */
const CASES = [
    ["not your turn", () => refusal(base(), "bob", "TAKE_TOKEN", { takeTokens: { Red: 1 } }), "INVALID_PLAYER"],
    ["action not pending", () => refusal(base(), "alice", "CASCADE_1", { cardId: "01" }), "ACTION_NOT_ALLOWED"],
    ["unknown action", () => refusal(base({ actions: ["FOO"] }), "alice", "FOO", {}), "ACTION_NOT_ALLOWED"],
    ["game over", () => { const e = base(); e.state.gameOver = true; return refusal(e, "alice", "TAKE_TOKEN", { takeTokens: {} }); }, "GAME_OVER"],
    ["gold take", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Gold: 1 } }), "GOLD_CANNOT_BE_TAKEN"],
    ["three of a colour", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Red: 3 } }), "INVALID_TOKENS_GIVEN"],
    ["satchel put-back", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: { Satchel: 1 } }), "INVALID_TOKENS_GIVEN"],
    ["empty pile", () => refusal(base({ bank: tokens({ Blue: 4, Green: 4, Gold: 5 }) }), "alice", "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1 } }), "NOT_ENOUGH_TOKENS_ON_BOARD"],
    ["returning what you lack", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: { Blue: 1 } }), "NOT_ENOUGH_TOKENS_IN_INVENTORY"],
    ["over 10", () => refusal(base({ players: [player("alice", { tokens: { Red: 3, Blue: 3, Green: 3 } }), player("bob")] }), "alice", "TAKE_TOKEN",
        { takeTokens: { White: 1, Brown: 1, Red: 1 } }), "MAXIMUM_TOKENS_IN_INVENTORY"],
    ["returning below 10", () => refusal(base({ players: [player("alice", { tokens: { Red: 1 } }), player("bob")] }), "alice", "TAKE_TOKEN",
        { takeTokens: { Blue: 1, Green: 1, White: 1 }, putBackTokens: { Red: 1 } }), "TOO_MANY_TOKENS_RETURNED"],
    ["missing takeTokens", () => refusal(base(), "alice", "TAKE_TOKEN", {}), "MALFORMED"],
    ["takeTokens not an object", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: 5 }), "MALFORMED"],
    ["unknown token", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Ruby: 1 } }), "MALFORMED"],
    ["fractional amount", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Red: 1.5 } }), "MALFORMED"],
    ["negative amount", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Red: -1 } }), "MALFORMED"],
    ["huge amount", () => refusal(base(), "alice", "TAKE_TOKEN", { takeTokens: { Red: 101 } }), "MALFORMED"],
    ["empty card id", () => refusal(base(), "alice", "BUY_CARD", { cardId: " ", tokens: {} }), "MALFORMED"],
    ["missing card id", () => refusal(base(), "alice", "RESERVE_CARD", {}), "MALFORMED"],
    ["bad put-back token", () => refusal(base(), "alice", "RESERVE_CARD", { cardId: "01", putBackToken: "Ruby" }), "MALFORMED"],
    ["underpaying", () => refusal(base(), "alice", "BUY_CARD", { cardId: "01", tokens: {} }), "PAYMENT_TOO_LOW"],
    ["overpaying", () => refusal(base({ players: [player("alice", { tokens: { Green: 4, Red: 1 } }), player("bob")] }), "alice", "BUY_CARD",
        { cardId: "01", tokens: { Green: 4, Red: 1 } }), "PAYMENT_TOO_HIGH"],
    ["paying with tokens you lack", () => refusal(base(), "alice", "BUY_CARD", { cardId: "01", tokens: { Green: 4 } }), "NOT_ENOUGH_TOKENS_IN_INVENTORY"],
    ["sacrifice without bonuses", () => refusal(base(), "alice", "BUY_CARD", { cardId: "111", tokens: {} }), "NOT_ENOUGH_BONUSES"],
    ["buying a card that is gone", () => refusal(base(), "alice", "BUY_CARD", { cardId: "999", tokens: {} }), "CARD_GONE"],
    ["satchel without a gem card", () => refusal(base({ players: [player("alice", { tokens: { Blue: 2, Red: 3 } }), player("bob")] }), "alice", "BUY_CARD",
        { cardId: "091", tokens: { Blue: 2, Red: 3 } }), "SATCHEL_NEEDS_GEM_CARD"],
    ["reserving a card that is gone", () => refusal(base(), "alice", "RESERVE_CARD", { cardId: "999" }), "CARD_GONE"],
    ["a fourth reserve", () => refusal(base({ players: [player("alice", { reserved: ["05", "06", "07"] }), player("bob")] }), "alice", "RESERVE_CARD", { cardId: "01" }), "MAXIMUM_CARDS_RESERVED"],
    ["put-back below 10", () => refusal(base(), "alice", "RESERVE_CARD", { cardId: "01", putBackToken: "Gold" }), "PUT_BACK_NOT_ALLOWED"],
    ["satchel put-back on reserve", () => refusal(base(), "alice", "RESERVE_CARD", { cardId: "01", putBackToken: "Satchel" }), "INVALID_TOKENS_GIVEN"],
    ["put-back of a colour not held", () => refusal(base({ players: [player("alice", { tokens: { Red: 4, Blue: 3, Green: 3 } }), player("bob")] }), "alice", "RESERVE_CARD",
        { cardId: "01", putBackToken: "White" }), "NOT_ENOUGH_TOKENS_IN_INVENTORY"],
    ["cascade of the wrong tier", () => refusal(base({ actions: ["CASCADE_1"] }), "alice", "CASCADE_1", { cardId: "071" }), "CASCADE_WRONG_TIER"],
    ["cascade into a satchel without a gem card", () => refusal(base({ actions: ["CASCADE_1"] }), "alice", "CASCADE_1", { cardId: "091" }), "SATCHEL_NEEDS_GEM_CARD"],
    ["cascade into a missing card", () => refusal(base({ actions: ["CASCADE_2"] }), "alice", "CASCADE_2", { cardId: "999" }), "CARD_GONE"],
    ["satchel colour missing", () => refusal(base({ actions: ["CHOOSE_SATCHEL_TOKEN"] }), "alice", "CHOOSE_SATCHEL_TOKEN", { cardId: "091" }), "MALFORMED"],
    ["satchel card not owned", () => refusal(base({ actions: ["CHOOSE_SATCHEL_TOKEN"] }), "alice", "CHOOSE_SATCHEL_TOKEN", { cardId: "091", selected: "Red" }), "SATCHEL_ALREADY_SET"],
    ["satchel card already assigned", () => {
        const sat = card("091");
        sat.tokenType = "Red";
        const alice = player("alice", { cards: ["09"] });
        alice.devCards.push(sat);
        return refusal(base({ players: [alice, player("bob")], actions: ["CHOOSE_SATCHEL_TOKEN"] }), "alice", "CHOOSE_SATCHEL_TOKEN", { cardId: "091", selected: "Red" });
    }, "SATCHEL_ALREADY_SET"],
    ["satchel colour you lack", () => {
        const alice = player("alice", { cards: ["09"] });
        alice.devCards.push(card("091"));
        return refusal(base({ players: [alice, player("bob")], actions: ["CHOOSE_SATCHEL_TOKEN"] }), "alice", "CHOOSE_SATCHEL_TOKEN", { cardId: "091", selected: "Blue" });
    }, "INVALID_TOKEN_CHOSEN"],
    ["satchel colour Gold", () => {
        const alice = player("alice", { cards: ["09"] });
        alice.devCards.push(card("091"));
        return refusal(base({ players: [alice, player("bob")], actions: ["CHOOSE_SATCHEL_TOKEN"] }), "alice", "CHOOSE_SATCHEL_TOKEN", { cardId: "091", selected: "Gold" });
    }, "INVALID_TOKEN_CHOSEN"],
    ["reserving a missing noble", () => refusal(base({ actions: ["RESERVE_NOBLE"] }), "alice", "RESERVE_NOBLE", { cardId: "20011" }), "NOBLE_GONE"],
    ["choosing a noble you do not qualify for", () => refusal(base({ actions: ["CHOOSE_NOBLE"] }), "alice", "CHOOSE_NOBLE", { cardId: "20002" }), "NOBLE_NOT_QUALIFIED"],
    ["a city in a game without cities", () => refusal(base({ actions: ["CHOOSE_CITY"] }), "alice", "CHOOSE_CITY", { cityId: "40001" }), "NO_CITIES"],
    ["a city that is gone", () => refusal(base({ version: "BASE_ORIENT_CITIES", actions: ["CHOOSE_CITY"] }), "alice", "CHOOSE_CITY", { cityId: "40002" }), "CITY_GONE"],
    ["a city you do not qualify for", () => refusal(base({ version: "BASE_ORIENT_CITIES", actions: ["CHOOSE_CITY"] }), "alice", "CHOOSE_CITY", { cityId: "40001" }), "CITY_NOT_QUALIFIED"],
    ["extra token: gold", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"] }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER", { takeToken: "Gold" }), "GOLD_CANNOT_BE_TAKEN"],
    ["extra token: satchel put-back", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"] }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
        { takeToken: "Red", putBackToken: "Satchel" }), "INVALID_TOKENS_GIVEN"],
    ["extra token: put-back without a take", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"] }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
        { putBackToken: "Red" }), "PUT_BACK_NOT_ALLOWED"],
    ["extra token: empty pile", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"], bank: tokens({ Gold: 5 }) }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
        { takeToken: "Red" }), "NOT_ENOUGH_TOKENS_ON_BOARD"],
    ["extra token: needless put-back", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"] }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
        { takeToken: "Red", putBackToken: "Red" }), "TOO_MANY_TOKENS_RETURNED"],
    ["extra token: returning what you lack", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"],
        players: [player("alice", { tokens: { Red: 4, Blue: 3, Green: 3 } }), player("bob")] }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
    { takeToken: "White", putBackToken: "Brown" }), "NOT_ENOUGH_TOKENS_IN_INVENTORY"],
    ["extra token: over 10", () => refusal(base({ actions: ["TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER"],
        players: [player("alice", { tokens: { Red: 4, Blue: 3, Green: 3 } }), player("bob")] }), "alice", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
    { takeToken: "White" }), "MAXIMUM_TOKENS_IN_INVENTORY"],
];

test("every message the engine raises maps to its own copy", (t) => {
    const texts = [];
    for (const [label, run, code] of CASES) {
        const text = run();
        texts.push(text);
        const m = mapServerError(text, 400);
        assert.equal(m.code, code, `${label}: "${text}"`);
        assert.notEqual(m.code, "UNKNOWN", `${label}: "${text}" falls back to the default copy`);
    }
    // Every RuleError the engine source can raise was triggered above: each MSG
    // text, and the fixed opening of each free-form message.
    const src = readFileSync(fileURLToPath(new URL("../fixtures/engine.mjs", import.meta.url)), "utf8");
    const msgBlock = /const MSG = \{([\s\S]*?)\n\};/.exec(src)[1];
    const messages = [...msgBlock.matchAll(/^\s*(\w+): "(.*)",$/gm)].map((m) => ({ key: m[1], text: m[2] }));
    assert.ok(messages.length >= 15, `${messages.length} MSG entries found`);
    for (const { key, text } of messages) assert.ok(texts.includes(text), `MSG.${key} was never triggered: "${text}"`);
    const sites = [...src.matchAll(/new RuleError\(\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1].slice(1, -1));
    assert.ok(sites.length >= 15, `${sites.length} free-form throw sites found`);
    for (const site of sites) {
        // the literal parts of the template, in order
        const parts = site.split(/\$\{[^}]*\}/).filter((p) => p.length > 0);
        const hit = texts.some((text) => {
            let at = 0;
            for (const part of parts) {
                const i = text.indexOf(part, at);
                if (i < 0 || (at === 0 && !site.startsWith("${") && i !== 0)) return false;
                at = i + part.length;
            }
            return true;
        });
        assert.ok(hit, `the engine's message ${site} was never triggered`);
    }
    t.diagnostic(`${CASES.length} refusals, ${messages.length} MSG texts and ${sites.length} free-form throw sites covered`);
});
