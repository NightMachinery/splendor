// The offline stack (tests/fixtures/fake-stack.mjs) that `pnpm run
// test:e2e:fake` runs the full-stack specs against: it must answer the way
// the real services do where the specs and the client depend on it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startFakeStack } from "../fixtures/fake-stack.mjs";
import { SplendorApi } from "../e2e/lib/splendor-api.mjs";
import { playGame } from "../e2e/lib/bot.mjs";

/** @type {Awaited<ReturnType<typeof startFakeStack>>} */
let stack;
/** @type {SplendorApi} */
let api;

before(async () => {
    stack = await startFakeStack({ seed: 5, holdMs: 300 });
    api = new SplendorApi({ lsUrl: stack.lsUrl, gsUrl: stack.gsUrl });
});
after(() => stack.close());

test("local-auth maps one token to one account", async () => {
    const token = "ab".repeat(24);
    const a = await api.localAuth({ displayName: "Ada Lovelace", token });
    const b = await api.localAuth({ displayName: "Someone Else", token });
    assert.equal(a.username, b.username);
    assert.equal(b.displayName, "Ada Lovelace");
    const c = await api.localAuth({ displayName: "Ada Lovelace" });
    assert.notEqual(c.username, a.username);
});

test("a whole game over HTTP, then the LS forgets the session", async () => {
    const result = await playGame({ api, players: 3, version: "BASE_ORIENT_CITIES_NOBLES", seed: 9 });
    assert.ok(/^\d{19}$/.test(result.sessionId), `63-bit id as a string: ${result.sessionId}`);
    assert.equal(await api.getLobbySession(result.sessionId), null);
    const after = await api.putAction(result.users[0], result.sessionId, "TAKE_TOKEN", { takeTokens: {}, putBackTokens: {} });
    assert.equal(after.status, 400);
    assert.deepEqual(await api.getActionNames(result.users[0].username, result.sessionId), []);
});

test("auth, turn order and refused moves answer like the real GS", async () => {
    const [alice, bob] = await api.createUsers(2, "Unit");
    const id = await api.createGame({ users: [alice, bob], version: "BASE_ORIENT" });
    const take = { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} };
    assert.equal((await api.putAction({ username: alice.username, token: bob.token }, id, "TAKE_TOKEN", take)).status, 401);
    assert.equal((await api.putAction(bob, id, "TAKE_TOKEN", take)).status, 400);
    assert.equal((await api.putAction(alice, id, "CASCADE_1", {})).status, 400);
    assert.equal((await api.putAction(alice, id, "TAKE_TOKEN", { takeTokens: { Gold: 1 }, putBackTokens: {} })).status, 400);
    assert.deepEqual(await api.getActionNames(alice.username, id), ["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"]);
    assert.equal((await api.request("GET", `${api.gsUrl}/api/sessions/${id}/players/${bob.username}/actions`)).status, 400);
    assert.equal((await api.putAction(alice, id, "TAKE_TOKEN", take)).status, 200);
    assert.equal((await api.getState(id)).turnCounter, 1);
});

test("long-polls hold an unchanged hash, then answer 204, and answer at once on change", async () => {
    const users = await api.createUsers(2, "Poll");
    const id = await api.createGame({ users, version: "BASE_ORIENT" });
    const text = (await api.getStateText(id)).text;
    const hash = createHash("md5").update(text).digest("hex");
    let t0 = Date.now();
    const idle = await api.getStateText(id, { hash });
    assert.equal(idle.status, 204);
    assert.ok(Date.now() - t0 >= 250, "held until holdMs");

    t0 = Date.now();
    const pending = api.getStateText(id, { hash });
    await api.putAction(users[0], id, "TAKE_TOKEN", { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} });
    const changed = await pending;
    assert.equal(changed.status, 200);
    assert.notEqual(changed.text, text);
    assert.ok(Date.now() - t0 < 250, "answered on change, not at the deadline");

    assert.equal((await api.getStateText("123")).status, 400);
});

/** A game's moves with the per-run usernames replaced by seat numbers. */
const bySeat = (result) => {
    const seat = new Map(result.users.map((u, i) => [u.username, `seat ${i}`]));
    return result.moves.map((m) => ({ ...m, player: seat.get(m.player) }));
};

test("a seeded game is dealt and played the same way in every run, whatever ran before it", async () => {
    // Two separate stacks, as two runs would start, with other sessions created
    // before the seeded game in one of them (parallel workers do that).
    const other = await startFakeStack({ seed: 77, holdMs: 300 });
    try {
        const api2 = new SplendorApi({ lsUrl: other.lsUrl, gsUrl: other.gsUrl });
        for (let i = 0; i < 3; i++) await api2.createGame({ users: await api2.createUsers(2, `Noise ${i}`), version: "BASE_ORIENT" });
        const a = await playGame({ api, players: 3, version: "BASE_ORIENT_TRADE_ROUTES", seed: 31 });
        const b = await playGame({ api: api2, players: 3, version: "BASE_ORIENT_TRADE_ROUTES", seed: 31 });
        assert.notEqual(a.users[0].username, b.users[0].username, "fresh users in each run");
        const deal = (r) => JSON.stringify(r.initial, (k, v) => (k === "name" || k === "colour" ? undefined : v));
        assert.equal(deal(a), deal(b), "the same deal");
        assert.deepEqual(bySeat(a), bySeat(b), "the same moves");
        assert.equal(a.turns, b.turns);

        // without a deal seed the stack's own seed and the session number decide
        const [x, y] = await api.createUsers(2, "Unseeded");
        const unseeded = await api.getState(await api.createGame({ users: [x, y], version: "BASE_ORIENT_TRADE_ROUTES" }));
        assert.notEqual(deal({ initial: unseeded }), deal(a));
        assert.equal((await api.request("POST", `${api.lsUrl}/api/sessions`, {
            query: { access_token: x.token },
            json: { creator: x.username, game: "splendor_BASE_ORIENT", savegame: "" },
            headers: { "x-e2e-deal-seed": "abc" },
        })).status, 400, "a deal seed that is not a whole number is refused");
    } finally {
        await other.close();
    }
});
