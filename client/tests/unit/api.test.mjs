// SplendorApi (tests/e2e/lib/splendor-api.mjs) against a tiny local HTTP fake
// of the Lobby Service and Game Service: checks the URLs, query parameters
// and bodies it sends, and how it reads the answers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SplendorApi, ApiError, randomToken } from "../e2e/lib/splendor-api.mjs";

/** @type {Array<{ method: string, path: string, query: Record<string, string>, headers: Record<string, any>, body: any }>} */
const seen = [];
const SESSION = "4611686018427387903"; // above Number.MAX_SAFE_INTEGER, as LS ids can be
let launched = false;
let server;
let base;

before(async () => {
    server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://x");
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
        const send = (status, text, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(text); };
        const p = url.pathname;
        if (p === "/ls/api/local-auth") {
            const username = body.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            return send(200, JSON.stringify({ token: body.token, username, displayName: body.displayName, preferredColour: "ABCDEF", role: "ROLE_PLAYER" }));
        }
        if (p === "/ls/api/sessions" && req.method === "POST") return send(200, SESSION);
        if (p === `/ls/api/sessions/${SESSION}` && req.method === "POST") { launched = true; return send(200, ""); }
        if (p.startsWith(`/ls/api/sessions/${SESSION}/players/`) && req.method === "PUT") return send(200, "");
        if (p === "/ls/api/sessions/1" && req.method === "GET") return send(400, "No updates available. Not a valid session id.", "text/plain");
        if (p === `/gs/api/sessions/${SESSION}` && req.method === "GET") {
            if (!launched) return send(400, "no session", "text/plain");
            return send(200, JSON.stringify({ turnCounter: 0, players: [] }));
        }
        if (p.startsWith(`/gs/api/sessions/${SESSION}/players/`) && req.method === "PUT") {
            return body?.takeTokens?.Gold ? send(400, "Gold cannot be taken like a gem.", "text/plain") : send(200, "");
        }
        if (p.endsWith("/api/online")) return send(200, "online", "text/plain");
        return send(404, "nope", "text/plain");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const api = () => new SplendorApi({ lsUrl: `${base}/ls/`, gsUrl: `${base}/gs`, timeoutMs: 5000 });

test("createGame creates, joins and launches through the LS, then waits for the GS", async () => {
    const a = api();
    await a.waitUntilOnline({ timeoutMs: 2000 });
    const [alice, bob] = await a.createUsers(2, "Unit Player");
    assert.match(alice.username, /^unit_player_1_/);
    assert.equal(alice.token.length, 48);
    const id = await a.createGame({ users: [alice, bob], version: "BASE_ORIENT_CITIES_NOBLES" });
    assert.equal(id, SESSION, "the id stays an exact string");

    const create = seen.find((r) => r.method === "POST" && r.path === "/ls/api/sessions");
    assert.deepEqual(create.body, { creator: alice.username, game: "splendor_BASE_ORIENT_CITIES_NOBLES", savegame: "" });
    assert.equal(create.query.access_token, alice.token);
    assert.equal(create.headers["x-e2e-deal-seed"], undefined, "no deal seed unless one is given");
    const join = seen.find((r) => r.method === "PUT" && r.path === `/ls/api/sessions/${SESSION}/players/${bob.username}`);
    assert.equal(join.query.access_token, bob.token);
    const launch = seen.find((r) => r.method === "POST" && r.path === `/ls/api/sessions/${SESSION}`);
    assert.equal(launch.query.access_token, alice.token);
    assert.deepEqual(await a.getState(id), { turnCounter: 0, players: [] });
});

test("a deal seed goes to the LS as the X-E2E-Deal-Seed header, which only the fake stack reads", async () => {
    const a = api();
    const [alice, bob] = await a.createUsers(2, "Unit Seeded");
    const from = seen.length;
    await a.createGame({ users: [alice, bob], version: "BASE_ORIENT", dealSeed: 4242 });
    const create = seen.slice(from).find((r) => r.method === "POST" && r.path === "/ls/api/sessions");
    assert.equal(create.headers["x-e2e-deal-seed"], "4242");
    assert.equal(create.headers["content-type"], "application/json; charset=utf-8", "the JSON body keeps its content type");
    assert.deepEqual(create.body, { creator: alice.username, game: "splendor_BASE_ORIENT", savegame: "" }, "the body is unchanged");
    await assert.rejects(a.createSession(alice, "BASE_ORIENT", "", { dealSeed: 1.5 }), /whole number/);
});

test("putAction reports a rejection instead of throwing, and sends the body as JSON", async () => {
    const a = api();
    const user = { username: "alice", token: "t0k" };
    const ok = await a.putAction(user, SESSION, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} });
    assert.deepEqual(ok, { status: 200, ok: true, text: "" });
    const bad = await a.putAction(user, SESSION, "TAKE_TOKEN", { takeTokens: { Gold: 1 }, putBackTokens: {} });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /Gold cannot be taken/);
    const sent = seen.filter((r) => r.path === `/gs/api/sessions/${SESSION}/players/alice/actions/TAKE_TOKEN`);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].query.access_token, "t0k");
});

test("errors carry the status and never the access token", async () => {
    const a = api();
    await assert.rejects(a.launchSession({ username: "x", token: "secret-token" }, "999"), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.ok(!err.message.includes("secret-token"), err.message);
        assert.match(err.message, /access_token=\*\*\*/);
        return true;
    });
    assert.equal(await a.getLobbySession("1"), null, "a 400 for an unknown LS session reads as gone");
});

test("random tokens are fresh 48-character hex strings", () => {
    const a = randomToken();
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.notEqual(a, randomToken());
});
