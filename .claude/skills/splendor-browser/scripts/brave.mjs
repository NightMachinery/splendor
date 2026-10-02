#!/usr/bin/env node
// @ts-check
/**
 * Probe a URL in the user's REAL, running Brave through brave-cli (a
 * chrome-cli wrapper that drives Brave over AppleScript). Optional; the
 * headless Chrome behind shot.mjs and probe.mjs is the default for
 * everything else. Use it to check that real Brave (its Shields, fonts and
 * rendering) agrees with headless Chrome.
 *
 *   node brave.mjs --url=http://127.0.0.1:PORT/login/ [--vp=phone | --width=390 --height=844]
 *   node brave.mjs --url=URL --window          # probe at the window's own width
 *
 * What it does, and nothing more:
 *   1. opens ONE new INCOGNITO Brave window (brave-cli open URL -i). It never
 *      touches, lists or reads existing tabs and windows (their titles and
 *      URLs are the user's business) and never writes to the real profile;
 *   2. phone width: the window loads a static file of the target origin
 *      (--harness-path, default /images/SplendorFavicon.png, so no app script
 *      runs at the top level), which is turned into a harness holding a
 *      same-origin <iframe> of the requested width that loads --url. Media
 *      queries then see that width. Touch, DPR and the user agent stay the
 *      real desktop ones;
 *   3. waits for the page to settle and runs the same in-page probe as
 *      probe.mjs inside the frame, then prints the JSON;
 *   4. closes only the tab it opened, which closes its incognito window
 *      (--keep-open leaves it for the user).
 *
 * It cannot take screenshots or emulate devices: use shot.mjs for that. It
 * never seeds an identity, so a board URL shows what a logged-out visitor
 * gets (the login redirect); probe the login, home or lobby pages, or a
 * board through a ?sessionId=...&migrate=... room link.
 *
 * Needs "Allow JavaScript from Apple Events" (Brave: View > Developer). If it
 * is off, the script says so, closes its window and exits 3; it never
 * changes the setting.
 *
 * Options: --url (required), --vp=NAME or --width/--height, --window,
 *   --harness-path=/x, --timeout=MS (default 20000), --settle=MS (default 700),
 *   --keep-open, --no-banner, --out=FILE, --brave-cli=PATH, --allow-remote
 *   (read-only probes of a deployed site are fine, but say so explicitly).
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sleep } from "./cdp.mjs";
import { VIEWPORTS, isLocalUrl } from "./browser.mjs";
import { readiness, pageProbe, probeExpression } from "./inpage.mjs";
import { parseArgs, last, die as dieWith } from "./util.mjs";

const TOOL = "brave.mjs";
const die = (/** @type {string} */ msg, code = 2) => dieWith(TOOL, msg, code);
const FRAME_ID = "splendor-browser-probe-frame";

const args = parseArgs(process.argv.slice(2));
const one = (/** @type {string} */ k) => last(args[k]);
const CLI = String(one("brave-cli") || "/opt/homebrew/bin/brave-cli");

/** @param {string[]} cliArgs @param {number} [timeoutMs] */
function cli(cliArgs, timeoutMs = 15_000) {
    try {
        return { ok: true, out: execFileSync(CLI, cliArgs, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim() };
    } catch (err) {
        const e = /** @type {any} */ (err);
        return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`.trim() || e.message };
    }
}

/** Best-effort screen banner (the user's Hammerspoon helper), skipped when absent. @param {string | null} msg */
function banner(msg) {
    if (one("no-banner")) return;
    try {
        const lua = msg ? `agentBannerOn(${JSON.stringify(msg)}, 120)` : "agentBannerOff()";
        execFileSync("hs", ["-q", "-c", lua], { stdio: "ignore", timeout: 5000 });
    } catch { /* no Hammerspoon here */ }
}

/** JS that the AppleScript bridge runs; must return a string. @param {Function} fn @param {Record<string, unknown>} opts */
const asJson = (fn, opts) => `JSON.stringify(${probeExpression(fn, opts)})`;

async function main() {
    const url = one("url") ? String(one("url")) : die("--url=URL is required");
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) die("--url must be http(s)");
    if (!isLocalUrl(url) && !one("allow-remote")) die(`refusing non-local ${target.origin} without --allow-remote (read-only, but be explicit)`);
    if (!existsSync(CLI)) die(`brave-cli not found at ${CLI}`);
    try {
        execFileSync("/usr/bin/pgrep", ["-x", "Brave Browser"], { stdio: "ignore" });
    } catch {
        die("Brave is not running; this mode only uses a running Brave (opening it would disturb the user)");
    }

    const windowMode = !!one("window");
    let width = Number(one("width") || 0);
    let height = Number(one("height") || 0);
    if (one("vp")) {
        const vp = VIEWPORTS[String(one("vp"))];
        if (!vp) die(`unknown --vp; use one of ${Object.keys(VIEWPORTS).join(", ")}`);
        width ||= vp.width;
        height ||= vp.height;
    }
    if (!windowMode) { width ||= 390; height ||= 844; }
    const timeoutMs = Number(one("timeout") || 20_000);
    const settleMs = Number(one("settle") || 700);
    const harness = `${target.origin}${String(one("harness-path") || "/images/SplendorFavicon.png")}`;

    banner(`Opening one incognito Brave window to probe ${target.host}; it closes itself`);
    /** @type {string | null} */
    let tabId = null;
    /** @type {string | null} */
    let windowId = null;
    /** @type {Record<string, unknown>} */
    const result = { url, mode: windowMode ? "window" : "frame", width: width || null, height: height || null };
    try {
        const opened = cli(["open", windowMode ? url : harness, "-i"]);
        // chrome-cli prints 64-bit ids, often negative: keep them as strings.
        const m = /^Id:\s*(-?\d+)/m.exec(opened.out);
        const w = /^Window id:\s*(-?\d+)/m.exec(opened.out);
        if (m) tabId = m[1];
        if (w) windowId = w[1];
        if (!opened.ok || !m) throw new Error(`brave-cli open failed: ${opened.out.slice(0, 300)}`);
        result.tabId = tabId;
        result.windowId = windowId;

        // Is JavaScript from Apple Events allowed? Retry briefly: a tab that is
        // still being created can answer nothing too.
        const tab = /** @type {string} */ (tabId);
        let probeJs = { ok: false, out: "" };
        for (let i = 0; i < 6; i++) {
            probeJs = cli(["execute", "'js' + 'ok'", "-t", tab]);
            if (probeJs.ok && probeJs.out === "jsok") break;
            await sleep(500);
        }
        if (!probeJs.ok || probeJs.out !== "jsok") {
            result.appleEventsJs = false;
            result.error = "JavaScript from Apple Events looks disabled in Brave (View > Developer > Allow JavaScript from Apple Events). "
                + `This script never changes that setting; ask the user to turn it on if a real-Brave check is needed. brave-cli said: ${JSON.stringify(probeJs.out.slice(0, 300))}`;
            process.exitCode = 3;
            return;
        }
        result.appleEventsJs = true;

        let frame;
        if (!windowMode) {
            const ready = await waitTop(tab, timeoutMs);
            if (!ready) throw new Error(`the harness page ${harness} did not load`);
            const build = `(() => {
                document.title = "splendor-browser probe";
                document.body.innerHTML = "";
                document.body.style.cssText = "margin:0;background:#444;display:block;min-height:100vh";
                const f = document.createElement("iframe");
                f.id = ${JSON.stringify(FRAME_ID)};
                f.src = ${JSON.stringify(url)};
                f.style.cssText = "display:block;margin:0 auto;border:0;background:#fff;width:${width}px;height:${height}px";
                document.body.appendChild(f);
                return "built";
            })()`;
            const built = cli(["execute", build, "-t", tab]);
            if (built.out !== "built") throw new Error(`could not build the harness: ${built.out.slice(0, 300)}`);
            frame = `#${FRAME_ID}`;
        }

        // Settle, then probe.
        const t0 = Date.now();
        let okSince = 0;
        /** @type {any} */
        let ready = { ready: false, reasons: ["not checked"] };
        while (Date.now() - t0 < timeoutMs) {
            const r = cli(["execute", asJson(readiness, { frame }), "-t", tab]);
            try { ready = JSON.parse(r.out); } catch { ready = { ready: false, reasons: [r.out.slice(0, 200) || "no answer"] }; }
            if (ready.ready) {
                okSince ||= Date.now();
                if (Date.now() - okSince >= settleMs) break;
            } else okSince = 0;
            await sleep(250);
        }
        result.ready = !!ready.ready;
        result.readyReasons = ready.reasons;
        result.waitMs = Date.now() - t0;
        const p = cli(["execute", asJson(pageProbe, { frame, touch: false, noIdentity: true }), "-t", tab], 30_000);
        try {
            result.probe = JSON.parse(p.out);
        } catch {
            // A cross-origin frame (X-Frame-Options or a redirect elsewhere) cannot be read.
            result.probe = null;
            result.error = `probe failed (if the frame was refused, retry with --window): ${p.out.slice(0, 300)}`;
            process.exitCode = 1;
        }
        if (windowMode && result.probe) {
            result.width = /** @type {any} */ (result.probe).viewport?.width ?? null;
            result.height = /** @type {any} */ (result.probe).viewport?.height ?? null;
        }
    } finally {
        if ((tabId || windowId) && !one("keep-open")) {
            // Close only what this run opened: its tab (the incognito window
            // goes with its last tab), or failing that its window.
            let closed = tabId ? cli(["close", "-t", tabId]) : { ok: false, out: "no tab id" };
            if (!closed.ok && windowId) closed = cli(["close", "-w", windowId]);
            const still = tabId ? cli(["info", "-t", tabId]) : { ok: true, out: "" };
            result.closed = closed.ok && !/^Id:/m.test(still.out);
            if (!result.closed) process.stderr.write(`${TOOL}: could not close tab ${tabId} / window ${windowId}: ${closed.out}\n`);
        }
        banner(null);
        // Printed after the cleanup, so "closed" is always in the report.
        const out = `${JSON.stringify(result, null, 2)}\n`;
        if (one("out")) writeFileSync(resolve(String(one("out"))), out);
        process.stdout.write(out);
    }
}

/** Wait until the top document of the tab has loaded. @param {string} tabId @param {number} timeoutMs */
async function waitTop(tabId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = cli(["execute", "document.readyState", "-t", tabId]);
        if (r.out === "complete") return true;
        await sleep(200);
    }
    return false;
}

main().catch((err) => {
    process.stderr.write(`${TOOL}: ${err?.stack || err}\n`);
    process.exitCode = 2;
});
