// @ts-check
/**
 * Self-tests for the splendor-browser scripts. No game stack is needed: the
 * browser tests serve their own tiny pages from a loopback HTTP server.
 *
 *   node --test .claude/skills/splendor-browser/tests/
 *
 * Tests that launch Chrome are skipped when it is not installed. Every
 * launched Chrome uses a profile root inside a temporary directory, and each
 * test checks that the root is empty afterwards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHROME, getBrowser, parseViewport } from "../scripts/browser.mjs";
import { pageProbe, probeExpression } from "../scripts/inpage.mjs";
import { expectedNetwork, identityProblem } from "../scripts/capture.mjs";

const HAVE_CHROME = existsSync(process.env.SPLENDOR_CHROME || DEFAULT_CHROME);
const noChrome = HAVE_CHROME ? false : "Google Chrome is not installed";

/** A scratch directory removed after the test. @param {import("node:test").TestContext} t */
const scratch = (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sb-selftest-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/**
 * Probe an HTML document in a fresh headless Chrome at the phone preset.
 * @param {import("node:test").TestContext} t @param {string} html
 */
async function probeHtml(t, html) {
    const root = scratch(t);
    const browser = await getBrowser({ noProxy: true, profileRoot: root });
    try {
        const page = await browser.newPage(await browser.newContext());
        await page.emulate(parseViewport("phone"));
        await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        return await page.evaluate(probeExpression(pageProbe, { touch: true }), { commandLineApi: true });
    } finally {
        await browser.close();
        assert.deepEqual(readdirSync(root), [], "the profile was not removed");
    }
}

test("hit grid: round and square controls with nothing over them are not covered", { skip: noChrome }, async (t) => {
    const probe = await probeHtml(t, `<!doctype html><meta name="viewport" content="width=device-width">
        <style>body { margin: 0 } #wrap { position: relative; padding: 20px } button { width: 60px; height: 60px; border: 0; margin: 4px }</style>
        <div id="wrap">
            <button id="round" style="border-radius: 50%">R</button>
            <button id="pill" style="width: 120px; border-radius: 30px">P</button>
            <button id="square">S</button>
            <span style="position: relative; display: inline-block">
                <button id="round2" style="border-radius: 50%; margin: 0">Q</button>
                <i style="position: absolute; left: 0; top: 0; width: 10px; height: 10px; background: red"></i>
            </span>
            <button id="under">U</button>
            <button id="noptr" style="pointer-events: none">N</button>
            <div style="position: absolute; left: 0; top: 0; width: 100%; height: 300px; pointer-events: none"></div>
        </div>
        <div style="position: absolute; left: 0; top: 200px; width: 100%; height: 100px; background: rgba(0,0,0,.2)"></div>
        <button id="covered" style="position: absolute; left: 20px; top: 220px">C</button>
        <div style="position: absolute; left: 0; top: 210px; width: 200px; height: 80px; background: #888"></div>`);
    const covered = new Map(probe.coveredControls.items.map((/** @type {any} */ i) => [i.el.replace(/^.*#/, "#").split(" ")[0].replace(/\..*/, ""), i]));
    // A round button: its box corners are outside its hit region.
    assert.ok(!covered.has("#round"), `round button reported: ${JSON.stringify(covered.get("#round"))}`);
    assert.ok(!covered.has("#pill"), `pill button reported: ${JSON.stringify(covered.get("#pill"))}`);
    assert.ok(!covered.has("#square"), "square button reported");
    // A sibling over the empty corner of a round button's box does not cover it.
    assert.ok(!covered.has("#round2"), `round button with a sibling in its box corner reported: ${JSON.stringify(covered.get("#round2"))}`);
    // Real findings are still found: a box drawn over a button, and a
    // button that cannot take taps at all (the tap goes to its parent).
    assert.ok(covered.has("#covered"), "a button under an opaque box was not reported");
    assert.equal(covered.get("#covered").points, "9/9");
    assert.ok(covered.has("#noptr"), "a pointer-events:none button was not reported");
    assert.match(covered.get("#noptr").by, /ancestor takes the tap/);
});

test("expectedNetwork: game-end answers are expected only once the game is over", () => {
    const over = { splendor: { gameOver: true } };
    const live = { splendor: { gameOver: false } };
    const poll = "http://127.0.0.1:1/ls/api/sessions/123?hash=ab12";
    assert.equal(expectedNetwork({ url: poll, status: 406 }, over), "LS drops the held poll of a finished game");
    assert.equal(expectedNetwork({ url: poll, status: 406 }, live), null);
    assert.equal(expectedNetwork({ url: "http://127.0.0.1:1/ls/api/sessions/123", status: 406 }, over), null, "406 without ?hash= is not the held poll");
    assert.equal(expectedNetwork({ url: poll, status: 400 }, over), "LS forgets a finished game");
    assert.equal(expectedNetwork({ url: poll, status: 400 }, live), null);
    assert.equal(expectedNetwork({ url: "http://127.0.0.1:1/ls/api/sessions/123/players/x", status: 400 }, over), null);
    assert.equal(expectedNetwork({ url: "http://127.0.0.1:1/ls/api/sessions?hash=ab", status: 408 }, live), "long-poll timeout");
    assert.equal(expectedNetwork({ url: "http://127.0.0.1:1/gs/api/games/1/board", status: 500 }, over), null);
});

test("identityProblem: a tab that ran as someone else is caught", () => {
    const p1 = { username: "cdp_p1", seat: 0 };
    const spectator = { username: "cdp_spectator", seat: null };
    const probe = (/** @type {any} */ sp) => ({ splendor: { me: "cdp_p1", ready: true, spectating: false, ...sp } });
    assert.equal(identityProblem(probe({}), p1, false), null);
    assert.match(String(identityProblem(probe({ me: "cdp_p1_2" }), p1, false)), /logged in as cdp_p1_2, not cdp_p1/);
    assert.match(String(identityProblem(probe({ me: null }), p1, false)), /logged in as nobody/);
    // The stored name was restored by another write, but the board had
    // rendered as an unseated user.
    assert.match(String(identityProblem(probe({ spectating: true }), p1, false)), /spectator view/);
    assert.equal(identityProblem(probe({ me: "cdp_spectator", spectating: true }), spectator, false), null);
    assert.equal(identityProblem(probe({ me: null }), null, false), null, "anon has no identity to check");
    assert.equal(identityProblem(probe({ me: null }), p1, true), null, "a redirect is reported as such");
});
