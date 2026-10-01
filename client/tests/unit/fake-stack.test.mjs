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
