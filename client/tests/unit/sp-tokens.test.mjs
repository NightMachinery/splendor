// Cascade checks for client/src/styles/sp/tokens.css in headless Chromium:
// the player-count HUD heights must resolve on html as well as on body,
// because html-level rules (scroll-padding-top) read them there. See
// docs/ui/foundations.md, "Geometry".
//
// This needs Playwright's Chromium (pnpm exec playwright install chromium);
// without it the tests are skipped, not failed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const TOKENS = readFileSync(fileURLToPath(new URL("../../src/styles/sp/tokens.css", import.meta.url)), "utf8");
/** tokens.css as a browser without :has() sees it: those rules are dropped whole. */
const TOKENS_NO_HAS = TOKENS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[^{}]*:has\([^{]*\{[^}]*\}/g, "");

const P = { width: 375, height: 667 };
const L = { width: 667, height: 375 };
const T = { width: 768, height: 1024 };
const D = { width: 1440, height: 900 };
const W = { width: 1920, height: 1080 };

let browser = null;
let skip = "";

before(async () => {
    try {
        browser = await chromium.launch();
    } catch (err) {
        skip = `Playwright Chromium is not available: ${err.message.split("\n")[0]}`;
    }
});

after(async () => {
    await browser?.close();
});

/**
 * Render tokens.css with the given attributes and return the resolved HUD
 * tokens on html and on body.
 */
async function hud({ viewport, css = TOKENS, html = null, body = null }) {
    const page = await browser.newPage({ viewport });
    try {
        const attr = (v) => (v === null ? "" : ` data-sp-players="${v}"`);
        await page.setContent(`<!doctype html><html${attr(html)}><head><style>${css}</style></head><body${attr(body)}></body></html>`);
        return await page.evaluate(() => {
            const read = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
            const root = document.documentElement;
            return {
                html: read(root, "--sp-hud-h"),
                body: read(document.body, "--sp-hud-h"),
                htmlL: read(root, "--sp-l-hud-h"),
                bodyL: read(document.body, "--sp-l-hud-h"),
            };
        });
    } finally {
        await page.close();
    }
}

const CASES = [
    // [name, options, expected --sp-hud-h and --sp-l-hud-h, each on both html and body]
    ["P, 2 players", { viewport: P, html: "2", body: "2" }, "48px", "76px"],
    ["P, 3 players on body only (:has)", { viewport: P, body: "3" }, "76px", "108px"],
    ["P, 4 players on html and body", { viewport: P, html: "4", body: "4" }, "76px", "108px"],
    ["P, 3 players on the html mirror only", { viewport: P, html: "3" }, "76px", "108px"],
    ["L, 3 players on body only", { viewport: L, body: "3" }, "76px", "108px"],
    ["T, 4 players on html and body", { viewport: T, html: "4", body: "4" }, "56px", "108px"],
    ["T, 3 players on body only", { viewport: T, body: "3" }, "56px", "108px"],
    ["D, 3 players on html and body", { viewport: D, html: "3", body: "3" }, "56px", "108px"],
    ["W, 4 players on body only", { viewport: W, body: "4" }, "56px", "108px"],
    ["T, 2 players", { viewport: T, body: "2" }, "56px", "76px"],
];

for (const [name, opts, want, wantL] of CASES) {
    test(`--sp-hud-h on html and body: ${name}`, async (t) => {
        if (skip) return t.skip(skip);
        const got = await hud(opts);
        assert.deepEqual({ html: got.html, body: got.body }, { html: want, body: want });
        assert.equal(got.htmlL, wantL, "--sp-l-hud-h on html");
        assert.equal(got.bodyL, wantL, "--sp-l-hud-h on body");
    });
}

test("without :has(), the html mirror still reaches html and T/D/W still reset to 56px", async (t) => {
    if (skip) return t.skip(skip);
    assert.ok(TOKENS_NO_HAS.length < TOKENS.length && !TOKENS_NO_HAS.includes(":has("), "the :has() rules were stripped");
    assert.deepEqual(await hud({ viewport: P, css: TOKENS_NO_HAS, html: "3", body: "3" }),
        { html: "76px", body: "76px", htmlL: "108px", bodyL: "108px" });
    // Body only: body (and so every board region) still gets 76px; html keeps 48px.
    const bodyOnly = await hud({ viewport: P, css: TOKENS_NO_HAS, body: "4" });
    assert.equal(bodyOnly.body, "76px");
    for (const viewport of [T, D, W]) {
        const got = await hud({ viewport, css: TOKENS_NO_HAS, html: "4", body: "4" });
        assert.deepEqual({ html: got.html, body: got.body }, { html: "56px", body: "56px" }, `${viewport.width}x${viewport.height}`);
    }
});

test("scroll-padding-top on html keeps a scrolled-to target clear of a 3-4 player sticky HUD", async (t) => {
    if (skip) return t.skip(skip);
    const page = await browser.newPage({ viewport: P });
    try {
        await page.setContent(`<!doctype html><html><head><style>${TOKENS}</style><style>
            html { scroll-padding-top: var(--sp-hud-h); }
            body { margin: 0; }
            #hud { position: sticky; top: 0; height: var(--sp-hud-h); background: #000; }
            #pad, #tail { height: 2000px; }
        </style></head><body data-sp-players="3"><header id="hud"></header><div id="pad"></div>
            <p id="target">target</p><div id="tail"></div></body></html>`);
        const got = await page.evaluate(() => {
            const target = document.getElementById("target");
            target.scrollIntoView({ block: "start" });
            return {
                hud: document.getElementById("hud").getBoundingClientRect().height,
                top: target.getBoundingClientRect().top,
            };
        });
        assert.equal(got.hud, 76);
        assert.ok(Math.abs(got.top - got.hud) < 1, `target top ${got.top}px, HUD ${got.hud}px tall`);
    } finally {
        await page.close();
    }
});
