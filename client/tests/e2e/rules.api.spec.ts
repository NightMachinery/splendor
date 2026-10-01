import { test, expect, seedFor } from "./lib/e2e.js";
import { nextAction, currentPlayer, total, GEMS } from "./lib/bot.mjs";
import type { SplendorApi, User } from "./lib/splendor-api.mjs";

// Negative probes against the real Game Service: every illegal move must be
// refused (400, or 401 for a wrong token) and must leave the state exactly as
// it was, byte for byte. Then a legal move must still work.
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

test("illegal token takes, purchases and out-of-turn moves are refused", async ({ api }) => {
    const [alice, bob] = await api.createUsers(2, "E2E Rules");
    const id = await api.createGame({ users: [alice, bob], version: "BASE_ORIENT" });
    const state = await api.getState(id);
    const card = state.tier1Deck.visibleCards[0];
    const pass = { takeTokens: {}, putBackTokens: {} };

    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Gold: 1 }, putBackTokens: {} }, "Gold taken like a gem");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: -1, Blue: 1 }, putBackTokens: {} }, "a negative take");
    await probe(api, id, alice, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: { Gold: -3 } }, "a negative put-back (free gold)");
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
    await probe(api, id, bob, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} }, "moving out of turn");
    await probe(api, id, { username: alice.username, token: bob.token }, "TAKE_TOKEN", pass, "someone else's token", 401);

    // A legal move still works, and the 2-player red pile drops to 3.
    const ok = await api.putAction(alice, id, "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} });
    expect(ok.status, ok.text).toBe(200);
    expect((await api.getState(id)).tokens.Red).toBe(3);
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
    await probe(api, id, alice, "RESERVE_CARD", { cardId: state.tier3Deck.visibleCards[0].id }, "a fourth reservation");
});

test("overpaying for a card is refused", async ({ api }) => {
    const users = await api.createUsers(2, "E2E Overpay");
    const id = await api.createGame({ users, version: "BASE_ORIENT" });
    const seed = seedFor("overpay");
    // Play until someone is about to buy with gems to spare in a colour the card asks for.
    let found: { user: User; body: any } | null = null;
    await playUntil(api, id, users, seed, (state) => {
        const me = currentPlayer(state);
        const move = nextAction(state, me.name, { seed });
        if (move?.action !== "BUY_CARD") return false;
        const paid = move.body.tokens as Record<string, number>;
        const spare = GEMS.find((g) => (paid[g] ?? 0) > 0 && me.tokens[g] > paid[g]);
        if (!spare) return false;
        found = { user: users.find((u) => u.username === me.name)!, body: { ...move.body, tokens: { ...paid, [spare]: paid[spare] + 1 } } };
        return true;
    });
    test.skip(!found, "no purchase with spare gems came up in 200 moves");
    const { user, body } = found!;
    expect(total(body.tokens)).toBeGreaterThan(0);
    await probe(api, id, user, "BUY_CARD", body, `overpaying ${JSON.stringify(body.tokens)} for ${body.cardId}`);
});
