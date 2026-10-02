// Unit tests for the identity check in src/scripts/settings.js
// (SETTINGS.verifyCredentials and isDefinitiveAuthRejection): the stored
// identity survives every reply that is not a definitive rejection, the
// check is cached once per page load, a hung request times out instead of
// freezing the page, and a rejected migrate link uses the local identity
// for the token as well as the username. See docs/client-architecture.md,
// "Identity model".
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeBrowser, flush } from "./client-fake-browser.mjs";

const browser = installFakeBrowser();
const {
    SETTINGS, isDefinitiveAuthRejection, AuthRejectedError, TransientAuthError, IDENTITY_REQUEST_TIMEOUT_MS,
} = await import("../../src/scripts/settings.js");

const STORED = { displayName: "Alice", accessToken: "a".repeat(48), username: "alice" };

const storeIdentity = () => {
    for(const [key, value] of Object.entries(STORED)) localStorage.setItem(key, value);
};

const identityKeys = () => ({
    displayName: localStorage.getItem("displayName"),
    accessToken: localStorage.getItem("accessToken"),
    username: localStorage.getItem("username"),
});

const localAuthOk = (call) => {
    const sent = JSON.parse(call.body);
    return { status: 200, body: { token: sent.token, username: "alice", displayName: sent.displayName } };
};

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    browser.setUrl("http://splendor.test/lobby/");
    browser.fetch.calls.length = 0;
    browser.fetch.handler = localAuthOk;
    SETTINGS.invalidateCredentials();
});

test("isDefinitiveAuthRejection accepts only 401, 403 and the token-error JSON", () => {
    assert.equal(isDefinitiveAuthRejection(401), true);
    assert.equal(isDefinitiveAuthRejection(403, "<html>"), true);
    assert.equal(isDefinitiveAuthRejection(404, '{"error":"unknown_token"}'), true);
    assert.equal(isDefinitiveAuthRejection(400, '{"error":"invalid_token"}'), true);
    assert.equal(isDefinitiveAuthRejection(400, "Bad request"), false);
    assert.equal(isDefinitiveAuthRejection(404, '{"error":"not_found"}'), false);
    assert.equal(isDefinitiveAuthRejection(429), false);
    assert.equal(isDefinitiveAuthRejection(500, '{"error":"unknown_token"}'), false);
    assert.equal(isDefinitiveAuthRejection(502, "<html>Bad Gateway</html>"), false);
    assert.equal(isDefinitiveAuthRejection(200, '{"error":"unknown_token"}'), false);
});

test("a successful local-auth stores the identity, and the check is cached for the page load", async () => {
    storeIdentity();
    const first = await SETTINGS.verifyCredentials();
    assert.equal(first.username, "alice");
    await SETTINGS.verifyCredentials();
    await SETTINGS.verifyCredentials();
    assert.equal(browser.fetch.calls.length, 1, "one local-auth per page load");
    assert.deepEqual(JSON.parse(browser.fetch.calls[0].body), { token: STORED.accessToken, displayName: "Alice" });
    assert.deepEqual(identityKeys(), STORED);
    SETTINGS.invalidateCredentials();
    await SETTINGS.verifyCredentials();
    assert.equal(browser.fetch.calls.length, 2, "invalidateCredentials forces a new check");
});

for(const [label, reply] of [
    ["401", { status: 401, body: "Unauthorized" }],
    ["403", { status: 403, body: "" }],
    ["404 unknown_token", { status: 404, body: { error: "unknown_token" } }],
]) {
    test(`a ${label} clears the identity and asks for the login page`, async () => {
        storeIdentity();
        browser.fetch.handler = () => reply;
        await assert.rejects(SETTINGS.verifyCredentials(), (err) => err instanceof AuthRejectedError && err.authRejected === true);
        assert.deepEqual(identityKeys(), { displayName: null, accessToken: null, username: null });
        assert.equal(new URL(browser.getUrl()).pathname, "/login/");
    });
}

for(const [label, reply] of [
    ["400", { status: 400, body: "Bad request" }],
    ["429", { status: 429, body: "slow down" }],
    ["500", { status: 500, body: "boom" }],
    ["502 HTML", { status: 502, body: "<html>Bad Gateway</html>" }],
    ["200 HTML", { status: 200, body: "<html>maintenance</html>" }],
    ["200 JSON of the wrong shape", { status: 200, body: { ok: true } }],
    ["network error", "network"],
]) {
    test(`a ${label} keeps every identity key and is not cached`, async () => {
        storeIdentity();
        browser.fetch.handler = () => reply;
        await assert.rejects(SETTINGS.verifyCredentials(), (err) => err instanceof TransientAuthError && err.transient === true);
        assert.deepEqual(identityKeys(), STORED);
        assert.equal(new URL(browser.getUrl()).pathname, "/lobby/");
        browser.fetch.handler = localAuthOk;
        await SETTINGS.verifyCredentials();
        assert.equal(browser.fetch.calls.length, 2, "the failed check was retried, not served from the cache");
    });
}

test("no display name and no allowCreate sends the browser to the login page without a request", async () => {
    await assert.rejects(SETTINGS.verifyCredentials(), AuthRejectedError);
    assert.equal(browser.fetch.calls.length, 0);
    assert.equal(new URL(browser.getUrl()).pathname, "/login/");
});

test("allowCreate stores the token before the request and the display name only after success", async () => {
    browser.setUrl("http://splendor.test/login/");
    browser.fetch.handler = (call) => {
        assert.match(localStorage.getItem("accessToken"), /^[0-9a-f]{48}$/);
        assert.equal(localStorage.getItem("displayName"), null);
        return { status: 502, body: "" };
    };
    await assert.rejects(SETTINGS.verifyCredentials({ allowCreate: true, displayName: "Bob" }), TransientAuthError);
    const token = localStorage.getItem("accessToken");
    assert.equal(localStorage.getItem("displayName"), null);
    browser.fetch.handler = localAuthOk;
    await SETTINGS.verifyCredentials({ allowCreate: true, displayName: "Bob" });
    assert.equal(JSON.parse(browser.fetch.calls[1].body).token, token, "the retry reuses the stored token");
    assert.equal(localStorage.getItem("displayName"), "Bob");
});

test("a local-auth request that never answers times out as transient and frees the cache", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    storeIdentity();
    browser.fetch.handler = () => "hang";
    const pending = SETTINGS.verifyCredentials();
    const cached = SETTINGS.verifyCredentials();
    assert.equal(pending, cached, "callers share the pending promise");
    await flush();
    t.mock.timers.tick(IDENTITY_REQUEST_TIMEOUT_MS - 1);
    await flush();
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    assert.equal(settled, false, "still waiting just before the timeout");
    t.mock.timers.tick(1);
    await assert.rejects(pending, (err) => err instanceof TransientAuthError && /did not answer/.test(err.message));
    assert.equal(browser.fetch.calls[0].signal.aborted, true, "the request was aborted");
    assert.deepEqual(identityKeys(), STORED);
    browser.fetch.handler = localAuthOk;
    await SETTINGS.verifyCredentials();
    assert.equal(browser.fetch.calls.length, 2, "the next call starts a fresh request");
});

test("a reply whose body never arrives also times out", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    storeIdentity();
    browser.fetch.handler = () => "hang-body";
    const pending = SETTINGS.verifyCredentials();
    await flush();
    t.mock.timers.tick(IDENTITY_REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, TransientAuthError);
    assert.deepEqual(identityKeys(), STORED);
});

test("a valid migrate link uses the room user and the room token", async () => {
    storeIdentity();
    browser.setUrl("http://splendor.test/gameboard/?sessionId=42&migrate=room-ok");
    browser.fetch.handler = (call) => {
        assert.equal(new URL(call.url).pathname, "/ls/api/sessions/42/migrate/room-ok");
        return { status: 200, body: { name: "bob", displayName: "Bob", preferredColour: "" } };
    };
    await SETTINGS.verifyCredentials();
    assert.equal(browser.fetch.calls.length, 1, "no local-auth for a migrate link");
    assert.equal(SETTINGS.getUsername(), "bob");
    assert.equal(SETTINGS.getAccessToken(), "room-ok");
    assert.equal(SETTINGS.migrateLinkRejected(), false);
    assert.equal(sessionStorage.getItem("roomUser:42:room-ok"), "bob");
});

test("a migrate check that fails with 502 is transient and keeps the link", async () => {
    storeIdentity();
    browser.setUrl("http://splendor.test/gameboard/?sessionId=42&migrate=room-502");
    browser.fetch.handler = () => ({ status: 502, body: "" });
    await assert.rejects(SETTINGS.verifyCredentials(), TransientAuthError);
    assert.equal(SETTINGS.getAccessToken(), "room-502");
    assert.match(browser.getUrl(), /migrate=room-502/);
});

test("a rejected migrate link falls back to the local identity for the token and the username", async () => {
    storeIdentity();
    browser.setUrl("http://splendor.test/gameboard/?sessionId=42&migrate=room-dead");
    browser.fetch.handler = (call) => {
        if(call.url.includes("/migrate/")) return { status: 400, body: "Invalid migrate token for room." };
        return localAuthOk(call);
    };
    await SETTINGS.verifyCredentials();
    assert.equal(browser.fetch.calls.length, 2, "migrate check, then local-auth");
    assert.equal(SETTINGS.migrateLinkRejected(), true);
    assert.equal(SETTINGS.getUsername(), "alice");
    assert.equal(SETTINGS.getAccessToken(), STORED.accessToken, "the dead room token is no longer sent");
    assert.equal(browser.getUrl(), "http://splendor.test/gameboard/?sessionId=42", "the dead link left the address bar");
});

test("the fallback holds even where the address bar cannot be rewritten", async () => {
    storeIdentity();
    browser.setUrl("http://splendor.test/gameboard/?sessionId=43&migrate=room-dead-2");
    const replaceState = window.history.replaceState;
    window.history.replaceState = () => { throw new Error("SecurityError"); };
    try {
        browser.fetch.handler = (call) => {
            if(call.url.includes("/migrate/")) return { status: 400, body: "Migrated user no longer exists." };
            return localAuthOk(call);
        };
        await SETTINGS.verifyCredentials();
    } finally {
        window.history.replaceState = replaceState;
    }
    assert.match(browser.getUrl(), /migrate=room-dead-2/);
    assert.equal(SETTINGS.getUsername(), "alice");
    assert.equal(SETTINGS.getAccessToken(), STORED.accessToken);
});
