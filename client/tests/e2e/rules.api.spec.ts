import { test, expect, seedFor } from "./lib/e2e.js";
import { nextAction, currentPlayer, playGame, total, visibleCards, GEMS, MAIN_ACTIONS } from "./lib/bot.mjs";
import type { SplendorApi, User } from "./lib/splendor-api.mjs";

// Negative probes against the real Game Service: every illegal move must be
// refused (400, or 401 for a wrong token) and must leave the state exactly as
// it was, byte for byte. Then a legal move must still work.
//
// Probes that need a particular situation (a pending cascade, a purchase
// with spare gems) watch whole bot games through playGame's actor hook and
// fire when the situation comes up; the game then goes on to its end.
//
// Run: E2E_INSTANCE=<name> pnpm run test:e2e:api   (see docs/testing.md)

test.describe.configure({ mode: "parallel" });

/** Send an illegal move; expect a refusal and an unchanged state. */
async function probe(api: SplendorApi, sessionId: string, user: User, action: string, body: unknown, why: string, status = 400) {
    const before = await api.getStateText(sessionId);
    const res = await api.putAction(user, sessionId, action, body);
    expect.soft(res.status, `${why}: expected ${status}, got ${res.status} ${res.text}`).toBe(status);
    const after = await api.getStateText(sessionId);
    expect.soft(after.text === before.text, `${why}: the refused move changed the state`).toBe(true);
    return res;
}

/** Let the bot play moves until `until` says stop (or the turn budget runs out). */
async function playUntil(api: SplendorApi, sessionId: string, users: User[], seed: number, until: (state: any) => boolean, maxSteps = 200) {
    for (let i = 0; i < maxSteps; i++) {
        const state = await api.getState(sessionId);
        if (state.gameOver || until(state)) return state;
        const me = currentPlayer(state);
        const user = users.find((u) => u.username === me.name)!;
        const move = nextAction(state, me.name, { seed })!;
        const res = await api.putAction(user, sessionId, move.action, move.body);
        expect(res.status, `${me.name} ${move.reason}: ${res.text}`).toBe(200);
    }
    return null;
}

type ActorInfo = { state: any; user: User; users: User[]; move: { action: string; body: any; reason: string }; sessionId: string };

/**
 * Play whole 2-player games (up to `maxGames`, a new seed each) and call
 * `onMove` before every bot move. It returns true once it has probed what
 * it was waiting for; the current game is still played to the end. Returns
 * whether any call returned true.
 */
async function probeDuringGames(api: SplendorApi, version: string, label: string, onMove: (info: ActorInfo) => Promise<boolean>, maxGames = 12) {
    let done = false;
    for (let g = 1; g <= maxGames && !done; g++) {
        const users = await api.createUsers(2, `E2E ${label}`);
        await playGame({
            api, players: users, version, seed: seedFor(label, g),
            actor: async (info: Omit<ActorInfo, "users">) => {
                if (!done) done = await onMove({ ...info, users });
                return false; // the bot still sends its own move
            },
        });
    }
    return done;
}

const isFollowUp = (a: string) => !(MAIN_ACTIONS as readonly string[]).includes(a);

test("illegal token takes, purchases and out-of-turn moves are refused", async ({ api }) => {
    const [alice, bob] = await api.createUsers(2, "E2E Rules");
    const id = await api.createGame({ users: [alice, bob], version: "BASE_ORIENT" });
    const state = await api.getState(id);
    const card = state.tier1Deck.visibleCards[0];
    const pass = { takeTokens: {}, putBackTokens: {} };

    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Gold: 1 }, putBackTokens: {} }, "Gold taken like a gem");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Gold: 1, Red: 1, Blue: 1 }, putBackTokens: {} }, "Gold taken along with two gems");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Satchel: 1 }, putBackTokens: {} }, "a Satchel token taken");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: -1, Blue: 1 }, putBackTokens: {} }, "a negative take");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: { Gold: -3 } }, "a negative put-back of Gold (free gold)");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: { White: -2 } }, "a negative put-back of a gem");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 1.5 }, putBackTokens: {} }, "a fractional take");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 3 }, putBackTokens: {} }, "three of one colour");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 2, Blue: 1 }, putBackTokens: {} }, "two of a colour plus another");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1, White: 1 }, putBackTokens: {} }, "four colours");
    await probe(api, id, alice, "TAKE_TOKEN", { putBackTokens: {} }, "takeTokens missing");
    await probe(api, id, alice, "BUY_CARD", { cardId: card.id, tokens: {} }, "buying without paying");
    await probe(api, id, alice, "BUY_CARD", { cardId: card.id, tokens: { Red: 1 } }, "paying with tokens not held");
    await probe(api, id, alice, "BUY_CARD", { cardId: card.id, tokens: { Gold: -2 } }, "a negative payment");
    await probe(api, id, alice, "BUY_CARD", { cardId: "no-such-card", tokens: {} }, "an unknown card");
    if (state.nobleDeck.visibleCards.length) {
        await probe(api, id, alice, "RESERVE_CARD", { cardId: state.nobleDeck.visibleCards[0].id }, "reserving a noble");
    }
    await probe(api, id, alice, "CASCADE_1", { cardId: card.id }, "a follow-up that is not pending");
    await probe(api, id, alice, "CHOOSE_NOBLE", { cardId: state.nobleDeck.visibleCards[0]?.id ?? "x" }, "a noble without the bonuses");
    await probe(api, id, alice, "NO_SUCH_ACTION", {}, "an unknown action");
    await probe(api, id, bob, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} }, "moving out of turn");
    await probe(api, id, bob, "RESERVE_CARD", { cardId: card.id }, "reserving out of turn");
    await probe(api, id, { username: alice.username, token: bob.token }, "TAKE_TOKEN", pass, "someone else's token", 401);
    await probe(api, id, { username: alice.username, token: "not-a-token" }, "TAKE_TOKEN", pass, "an unknown token", 401);

    // A legal move still works, and the 2-player red pile drops to 3.
    const ok = await api.putAction(alice, id, "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} });
    expect(ok.status, ok.text).toBe(200);
    expect((await api.getState(id)).tokens.Red).toBe(3);
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { White: 1 }, putBackTokens: {} }, "a second move in the same turn");
    await probe(api, id, bob, "TAKE_TOKEN", { takeTokens: { Red: 2 }, putBackTokens: {} }, "two from a pile of 3");
    await probe(api, id, bob, "TAKE_TOKEN", { takeTokens: { White: 1 }, putBackTokens: { White: 1 } }, "returning tokens while under 10");
});

test("a fourth reserved card is refused", async ({ api }) => {
    const users = await api.createUsers(2, "E2E Reserve");
    const [alice] = users;
    const id = await api.createGame({ users, version: "BASE_ORIENT" });
    const seed = seedFor("reserve");
    for (let i = 0; i < 3; i++) {
        const state = await api.getState(id);
        const res = await api.putAction(alice, id, "RESERVE_CARD", { cardId: state.tier3Deck.visibleCards[0].id });
        expect(res.status, res.text).toBe(200);
        // bob plays one turn
        await playUntil(api, id, users, seed, (s) => currentPlayer(s)?.name === alice.username);
    }
    const state = await api.getState(id);
    expect(state.players[0].reservedCards).toHaveLength(3);
    expect(state.players[0].tokens.Gold, "each reservation gave a gold token").toBe(3);
    await probe(api, id, alice, "RESERVE_CARD", { cardId: state.tier3Deck.visibleCards[0].id }, "a fourth reservation");
    await probe(api, id, alice, "RESERVE_CARD", { cardId: state.tier1Deck.visibleCards[0].id }, "a fourth reservation from another tier");
});

test("overpaying for a card is refused", async ({ api }) => {
    let probed = "";
    const found = await probeDuringGames(api, "BASE_ORIENT", "overpay", async ({ state, user, move, sessionId }) => {
        if (move.action !== "BUY_CARD") return false;
        const me = currentPlayer(state);
        const paid = move.body.tokens as Record<string, number>;
        // a gem colour the card asks for, paid, of which the buyer holds more
        const spare = GEMS.find((g) => (paid[g] ?? 0) > 0 && me.tokens[g] > paid[g]);
        if (spare) {
            const body = { ...move.body, tokens: { ...paid, [spare]: paid[spare] + 1 } };
            expect(total(body.tokens)).toBeGreaterThan(0);
            const res = await probe(api, sessionId, user, "BUY_CARD", body, `overpaying ${JSON.stringify(body.tokens)} for ${body.cardId}`);
            expect.soft(res.text, "the refusal names the overpayment").toMatch(/more than this card costs|exact/i);
            probed = `${body.cardId} with ${JSON.stringify(body.tokens)}`;
            return true;
        }
        // or gold where the gems already cover the price
        if (!paid.Gold && me.tokens.Gold > 0) {
            const body = { ...move.body, tokens: { ...paid, Gold: 1 } };
            await probe(api, sessionId, user, "BUY_CARD", body, `paying ${JSON.stringify(body.tokens)} with gold to spare for ${body.cardId}`);
            probed = `${body.cardId} with ${JSON.stringify(body.tokens)}`;
            return true;
        }
        return false;
    });
    expect(found, "no purchase with spare gems or gold came up in 12 games").toBe(true);
    test.info().annotations.push({ type: "probe", description: `overpaid ${probed}` });
});

test("a cascade must take a visible card of the right tier", async ({ api }) => {
    let probed = "";
    const found = await probeDuringGames(api, "BASE_ORIENT", "cascade", async ({ state, user, move, sessionId }) => {
        const pending = (state.curValidActions as string[]).find((a) => a === "CASCADE_1" || a === "CASCADE_2");
        if (!pending) return false;
        const tier = pending === "CASCADE_1" ? 1 : 2;
        const wrongTiers = tier === 1 ? [2, 3] : [1, 3];
        for (const t of wrongTiers) {
            const wrong = visibleCards(state, `tier${t}Deck`)[0] ?? visibleCards(state, `tier${t}OrientDeck`)[0];
            if (wrong) await probe(api, sessionId, user, pending, { cardId: wrong.id }, `${pending} with a tier ${t} card ${wrong.id}`);
        }
        // a card of the right tier that is not on the board (one the player owns)
        const owned = currentPlayer(state).devCards.find((c: any) => c.cardTier === `TIER_${tier}`);
        if (owned) await probe(api, sessionId, user, pending, { cardId: owned.id }, `${pending} with an owned card ${owned.id}`);
        await probe(api, sessionId, user, pending, { cardId: "no-such-card" }, `${pending} with an unknown card`);
        await probe(api, sessionId, user, pending, {}, `${pending} without a card`);
        // the other cascade, and a main action, are not pending
        await probe(api, sessionId, user, pending === "CASCADE_1" ? "CASCADE_2" : "CASCADE_1", move.body, "the other cascade");
        await probe(api, sessionId, user, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} }, "a main action while a cascade is pending");
        probed = `${pending} in session ${sessionId}; the bot then took ${move.body.cardId}`;
        return true;
    });
    expect(found, "no cascade came up in 12 games").toBe(true);
    test.info().annotations.push({ type: "probe", description: probed });
});

test("pending follow-ups block the main actions and the next player", async ({ api }) => {
    const seen = new Set<string>();
    const wanted = ["CHOOSE_SATCHEL_TOKEN", "RESERVE_NOBLE"];
    await probeDuringGames(api, "BASE_ORIENT", "follow-ups", async ({ state, user, users, move, sessionId }) => {
        const pending = (state.curValidActions as string[]).filter(isFollowUp);
        const fresh = pending.find((a) => wanted.includes(a) && !seen.has(a));
        if (!fresh) return false;
        seen.add(fresh);
        await probe(api, sessionId, user, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} }, `TAKE_TOKEN while ${fresh} is pending`);
        await probe(api, sessionId, user, "BUY_CARD", { cardId: visibleCards(state, "tier1Deck")[0]?.id ?? "x", tokens: {} }, `BUY_CARD while ${fresh} is pending`);
        const other = users.find((u) => u.username !== user.username)!;
        await probe(api, sessionId, other, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} }, `the next player moving while ${fresh} is pending`);
        if (move.action === fresh) await probe(api, sessionId, other, fresh, move.body, `the next player answering ${fresh}`);
        if (fresh === "CHOOSE_SATCHEL_TOKEN") {
            const satchel = currentPlayer(state).devCards.find((c: any) => c.tokenType === "Satchel");
            await probe(api, sessionId, user, fresh, { cardId: satchel.id, selected: "Gold" }, "a Satchel turned into Gold");
            await probe(api, sessionId, user, fresh, { cardId: satchel.id, selected: "Satchel" }, "a Satchel turned into a Satchel");
        }
        if (fresh === "RESERVE_NOBLE") {
            await probe(api, sessionId, user, fresh, { cardId: "no-such-noble" }, "reserving an unknown noble");
        }
        return wanted.every((a) => seen.has(a));
    });
    test.info().annotations.push({ type: "probe", description: `probed while pending: ${[...seen].join(", ") || "none"}` });
    expect(seen.size, `follow-ups seen: ${[...seen].join(", ")}`).toBeGreaterThan(0);
});
