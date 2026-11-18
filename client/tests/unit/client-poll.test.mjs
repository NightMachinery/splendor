// Unit tests for the long-poll loop in src/scripts/settings.js
// (createLongPoll, backoffDelay) with a fake DOM, a scripted fetch and mock
// timers: the 750 ms minimum cycle, backoff, the stored hash, hidden tabs,
// wake-ups, stopping, and the connection hook. See
// docs/client-architecture.md, "The poll loop".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeBrowser, flush } from "./client-fake-browser.mjs";

const browser = installFakeBrowser("http://splendor.test/gameboard/?sessionId=7");
const { createLongPoll, backoffDelay, AuthRejectedError, LS_HOLDS_REQUESTS } = await import("../../src/scripts/settings.js");
const { md5Hex } = await import("../../src/scripts/local-md5.js");

let pollCounter = 0;
const polls = [];

/** A loop on /state whose url() records the hash it was asked to send. */
const makePoll = (extra = {}) => {
    const rendered = [];
    const sent = [];
    const poll = createLongPoll({
        name: `test-${++pollCounter}`,
        url: (hash) => { sent.push(hash); return `http://splendor.test/state?hash=${hash}`; },
        onUpdate: (data, text, hash) => { rendered.push({ data, hash }); },
        ...extra,
    });
    polls.push(poll);
    return { poll, rendered, sent };
};

const state = (n) => JSON.stringify({ n });

const enableTimers = (t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

/** Advance the mocked clock in small steps, letting promise callbacks run in between. */
const advance = async (t, ms, step = 50) => {
    for(let done = 0; done < ms; done += step) {
        await flush(3); // let a pending callback schedule its timer first
        t.mock.timers.tick(Math.min(step, ms - done));
        await flush(3);
    }
};

beforeEach(() => {
    polls.splice(0).forEach(p => p.stop());
    browser.fetch.calls.length = 0;
    browser.document.hidden = false;
    localStorage.clear();
    document.body.dataset = {};
});

test("backoffDelay grows exponentially with equal jitter, capped at 30 s", () => {
    for(let streak = 1; streak <= 8; streak++) {
        const ceiling = Math.min(30000, 1000 * 2 ** (streak - 1));
        for(let i = 0; i < 200; i++) {
            const d = backoffDelay(streak);
            assert.ok(d >= ceiling / 2 && d <= ceiling, `streak ${streak}: ${d} outside [${ceiling / 2}, ${ceiling}]`);
        }
    }
});

test("a server that answers at once cannot make the loop poll faster than every 750 ms", async (t) => {
    enableTimers(t);
    let n = 0;
    browser.fetch.handler = () => ({ status: 200, body: state(++n) });
    const { poll, rendered } = makePoll();
    poll.start();
    await advance(t, 3000);
    const starts = browser.fetch.calls.length;
    assert.ok(starts >= 4 && starts <= 5, `expected 4 or 5 requests in 3 s, got ${starts}`);
    assert.equal(rendered.length, starts);
});

test("a held request that times out (204 or 408) is renewed at once with the same hash", async (t) => {
    enableTimers(t);
    browser.fetch.handler = (call) => (call.url.endsWith("hash=-") ? { status: 200, body: state(1) } : { status: 408, body: "", delayMs: 30000 });
    const { poll, sent, rendered } = makePoll();
    poll.start();
    await advance(t, 1000);
    assert.equal(rendered.length, 1);
    const h = md5Hex(state(1));
    assert.deepEqual(sent, ["-", h]);
    await advance(t, 30000);
    assert.deepEqual(sent, ["-", h, h], "renewed right after the 408");
    assert.equal(poll.getHash(), h);
});

test("a 200 with the hash that was sent is treated as a misbehaving server and backed off", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 200, body: state(1) });
    const { poll, rendered } = makePoll();
    poll.start();
    await advance(t, 10000);
    assert.equal(rendered.length, 1, "the unchanged state is not rendered again");
    assert.ok(browser.fetch.calls.length <= 7, `backed off, got ${browser.fetch.calls.length} requests in 10 s`);
});

test("a failed render keeps the previous hash so the same state is fetched again", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 200, body: state(1) });
    let failures = 1;
    const errors = [];
    const { poll, sent } = makePoll({
        onUpdate: () => { if(failures-- > 0) throw new Error("render broke"); },
        onError: (err, info) => errors.push(info.kind),
    });
    poll.start();
    await advance(t, 3000);
    assert.equal(sent[0], "-");
    assert.equal(sent[1], "-", "the retry still sends the old hash");
    assert.deepEqual(errors, ["render"]);
    assert.equal(poll.getHash(), md5Hex(state(1)));
});

test("network errors back off, show the indicator, and a reply clears it", async (t) => {
    enableTimers(t);
    let down = true;
    browser.fetch.handler = () => (down ? "network" : { status: 200, body: state(1) });
    const { poll } = makePoll();
    poll.start();
    await advance(t, 5000);
    assert.equal(document.body.dataset.splendorConnection, "reconnecting");
    assert.equal(document.getElementById("splendor-connection-indicator").textContent, "Reconnecting...");
    const failedRequests = browser.fetch.calls.length;
    assert.ok(failedRequests >= 2 && failedRequests <= 4, `backoff: ${failedRequests} requests in 5 s`);
    down = false;
    await advance(t, 20000);
    assert.equal(document.body.dataset.splendorConnection, "ok");
    assert.equal(document.getElementById("splendor-connection-indicator").style.display, "none");
});

test("data-splendor-connection is set by the first outcome even when it is a client error", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 400, body: "Not a valid session id." });
    const kinds = [];
    const { poll } = makePoll({ onError: (err, info) => kinds.push(info.kind) });
    poll.start();
    await advance(t, 100);
    assert.deepEqual(kinds, ["client"]);
    assert.equal(document.body.dataset.splendorConnection, "ok");
});

test("a loop without pauseWhenHidden keeps polling in a hidden tab", async (t) => {
    enableTimers(t);
    let n = 0;
    browser.fetch.handler = () => ({ status: 200, body: state(++n), delayMs: 1000 });
    const { poll, rendered } = makePoll();
    browser.document.hidden = true;
    poll.start();
    await advance(t, 5000);
    assert.ok(rendered.length >= 4, `rendered ${rendered.length} states while hidden`);
});

test("pauseWhenHidden sends nothing while hidden and polls at once when the tab is shown", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 408, body: "", delayMs: 30000 });
    const { poll } = makePoll({ pauseWhenHidden: true });
    browser.document.hidden = true;
    poll.start();
    await advance(t, 5000);
    assert.equal(browser.fetch.calls.length, 0);
    browser.setHidden(false);
    await flush();
    assert.equal(browser.fetch.calls.length, 1);
});

test("the splendorPollWhenHidden override keeps a pausing loop polling", async (t) => {
    enableTimers(t);
    localStorage.setItem("splendorPollWhenHidden", "1");
    browser.fetch.handler = () => ({ status: 408, body: "", delayMs: 1000 });
    const { poll } = makePoll({ pauseWhenHidden: true });
    browser.document.hidden = true;
    poll.start();
    await advance(t, 3500);
    assert.ok(browser.fetch.calls.length >= 3);
});

test("online and visibilitychange abort the request in flight and send a fresh one", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 408, body: "", delayMs: 30000 });
    const { poll } = makePoll();
    poll.start();
    await flush();
    assert.equal(browser.fetch.calls.length, 1);
    browser.goOnline();
    await advance(t, 50);
    assert.equal(browser.fetch.calls[0].signal.aborted, true);
    assert.equal(browser.fetch.calls.length, 2);
    browser.setHidden(false);
    await advance(t, 50);
    assert.equal(browser.fetch.calls[1].signal.aborted, true);
    assert.equal(browser.fetch.calls.length, 3);
});

test("wake() skips the rest of a backoff", async (t) => {
    enableTimers(t);
    let down = true;
    browser.fetch.handler = () => (down ? { status: 503, body: "" } : { status: 200, body: state(1) });
    const { poll, rendered } = makePoll();
    poll.start();
    await advance(t, 8000);
    down = false;
    const before = browser.fetch.calls.length;
    poll.wake();
    await flush();
    assert.equal(browser.fetch.calls.length, before + 1);
    assert.equal(rendered.length, 1);
});

test("onGone returning true stops the loop for good", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 400, body: "No updates available. Not a valid session id." });
    const gone = [];
    const { poll } = makePoll({ onGone: (status) => { gone.push(status); return true; } });
    poll.start();
    await advance(t, 60000, 1000);
    assert.deepEqual(gone, [400]);
    assert.equal(browser.fetch.calls.length, 1);
    poll.wake();
    await flush();
    assert.equal(browser.fetch.calls.length, 1, "a stopped loop ignores wake()");
});

test("an AuthRejectedError from beforeRequest stops the loop without a request", async (t) => {
    enableTimers(t);
    const { poll } = makePoll({ beforeRequest: async () => { throw new AuthRejectedError("go to login"); } });
    poll.start();
    await advance(t, 60000, 1000);
    assert.equal(browser.fetch.calls.length, 0);
});

test("a transient beforeRequest failure backs off and shows the indicator", async (t) => {
    enableTimers(t);
    let attempts = 0;
    const transient = Object.assign(new Error("lobby unreachable"), { transient: true });
    browser.fetch.handler = () => ({ status: 200, body: state(1) });
    const { poll, rendered } = makePoll({ beforeRequest: async () => { if(attempts++ < 2) throw transient; } });
    poll.start();
    await flush();
    assert.equal(document.body.dataset.splendorConnection, "reconnecting");
    await advance(t, 5000);
    assert.equal(rendered.length, 1);
    assert.equal(document.body.dataset.splendorConnection, "ok");
});

test("hold: false polls every intervalMs with a hash that never matches, and renders only changes", async (t) => {
    enableTimers(t);
    let n = 1;
    browser.fetch.handler = () => ({ status: 200, body: state(n) });
    const { poll, sent, rendered } = makePoll({ hold: false, intervalMs: 3000 });
    poll.start();
    await advance(t, 9500);
    assert.equal(browser.fetch.calls.length, 4, "at 0, 3, 6 and 9 s");
    assert.ok(sent.every(h => h === "-"), "never sends a hash the server could hold on");
    assert.equal(rendered.length, 1, "an unchanged body is not rendered again");
    n = 2;
    await advance(t, 3000);
    assert.equal(rendered.length, 2);
    assert.equal(poll.getHash(), md5Hex(state(2)));
    assert.equal(document.body.dataset.splendorConnection, "ok");
});

test("hold: false skips the rest of the interval on wake(), and a seeded hash avoids a first re-render", async (t) => {
    enableTimers(t);
    browser.fetch.handler = () => ({ status: 200, body: state(5) });
    const { poll, rendered } = makePoll({ hold: false, intervalMs: 10000 });
    poll.setHash(md5Hex(state(5)));
    poll.start();
    await advance(t, 1000);
    assert.equal(browser.fetch.calls.length, 1);
    assert.equal(rendered.length, 0, "the state fetched before start() is not rendered twice");
    browser.fetch.handler = () => ({ status: 200, body: state(6) });
    poll.wake();
    await flush();
    assert.equal(browser.fetch.calls.length, 2);
    assert.equal(rendered.length, 1);
});

test("the LS loops do not let the Lobby Service hold requests until its thread leak is fixed", () => {
    // See LS_HOLDS_REQUESTS in settings.js before changing this.
    assert.equal(LS_HOLDS_REQUESTS, false);
});
