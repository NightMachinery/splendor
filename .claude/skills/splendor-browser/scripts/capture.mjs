// @ts-check
/**
 * The shared driver behind shot.mjs (screenshots + probe) and probe.mjs
 * (probe only). For every (perspective, viewport) pair it opens one tab in a
 * browser context of its own (so no two tabs ever share localStorage), seeds
 * the identity before any page script runs, loads the page, waits until it
 * has settled, runs the in-page probe, checks that the tab really ran as that
 * perspective and optionally captures a PNG. The run is described by a
 * manifest.json in --out-dir.
 *
 * Options (both tools):
 *   --identities=FILE   written by seed.mjs (origin, session and tokens)
 *   --instance=NAME | --base-url=URL   origin when there is no identities file
 *   --as=LIST           perspectives: p1,p2,... spectator, anon, or all (default: the seated players)
 *   --vp=LIST           se, phone, android, landscape, tablet, desktop, wide, or WxH[@dpr][,mobile]
 *                       (default phone,desktop)
 *   --matrix            every preset viewport
 *   --dpr=N             override the device pixel ratio of every viewport
 *   --insets[=V]        set html[data-sp-test-insets] (fake notch safe-area insets)
 *   --page=P            board (default when a game was launched), lobby, home, login, settings
 *   --path=/x?y         any path on the origin (overrides --page)
 *   --full              capture the whole document, not just the viewport
 *   --modals=M          keep (default) | close (hide open modals first) | both
 *   --click=SELECTOR    tap/click an element after the page settled (repeatable, in order)
 *   --eval=EXPR         run JS after the page settled (repeatable)
 *   --wait-for=EXPR     wait for this expression instead of the default readiness check
 *   --timeout=MS        readiness timeout per shot (default 30000); a timeout is recorded, not fatal
 *   --settle=MS         how long the page must stay ready before the probe (default 700)
 *   --assert=LIST       ready, no-overflow, no-hscroll, no-unreachable, no-clipped, tap-targets,
 *                       not-covered, no-broken-images, no-console-errors, no-http-errors, or all
 *   --jobs=N            tabs in flight at once (default 3)
 *   --out-dir=DIR       default $TMPDIR/splendor-browser/<tool>-<time>
 *   --label=NAME        prefix for the PNG names and the manifest
 *   --json              print the whole manifest to stdout
 *   --cdp=URL           attach to a running browser instead of launching one
 *   --chrome=PATH       Chrome binary (default Google Chrome.app; env SPLENDOR_CHROME)
 *   --profile-root=DIR  where the throwaway profile goes (default system temp dir)
 *   --keep-profile      do not delete the profile afterwards
 *   --headful           show the launched Chrome window (debugging only)
 *   --allow-remote      permit a non-loopback origin
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "./cdp.mjs";
import { getBrowser, parseViewportList, VIEWPORTS, isLocalUrl } from "./browser.mjs";
import { readiness, pageProbe, probeExpression } from "./inpage.mjs";
import { parseArgs, last, many, die as dieWith, stamp } from "./util.mjs";

const LIB = new URL("../../../../client/tests/e2e/lib/", import.meta.url);
const PAGES = { lobby: "/lobby/", home: "/", login: "/login/", settings: "/settings/" };
const IDENTITY_KEYS = ["accessToken", "refreshToken", "username", "displayName"];
/** Options that take a value (--key=value). */
const VALUED = new Set([
    "identities", "instance", "base-url", "as", "vp", "dpr", "page", "path", "modals", "click", "eval", "wait-for",
    "timeout", "settle", "assert", "jobs", "out-dir", "label", "cdp", "chrome", "profile-root",
]);
/** Plain flags (--flag). --insets is both: a flag, or --insets=VALUE. */
const FLAGS = new Set(["matrix", "full", "json", "keep-profile", "headful", "allow-remote", "png", "verbose"]);
const KNOWN = new Set([...VALUED, ...FLAGS, "insets"]);

/**
 * A numeric option: absent gives `fallback`; anything that is not a finite
 * number at least `min` (and whole, with `int`) is a usage error.
 * @param {unknown} raw last(args[key]) @param {string} key
 * @param {{ fallback: number, min: number, int?: boolean, max?: number }} opts
 * @returns {number | string} the number, or the error message
 */
export function numberOption(raw, key, opts) {
    if (raw === undefined) return opts.fallback;
    const text = typeof raw === "string" ? raw.trim() : "";
    const n = Number(text);
    const kind = opts.int ? "a whole number" : "a number";
    const range = opts.max === undefined ? `>= ${opts.min}` : `from ${opts.min} to ${opts.max}`;
    if (text === "" || !Number.isFinite(n) || (opts.int && !Number.isInteger(n)) || n < opts.min || (opts.max !== undefined && n > opts.max)) {
        return `--${key} must be ${kind} ${range}, got ${JSON.stringify(raw === true ? "(no value)" : raw)}`;
    }
    return n;
}

/** Assertion names accepted by --assert. */
export const ASSERTIONS = /** @type {const} */ ([
    "ready", "no-overflow", "no-hscroll", "no-unreachable", "no-clipped", "tap-targets", "not-covered",
    "no-broken-images", "no-console-errors", "no-http-errors",
]);

/**
 * Network failures that are part of normal operation: the Lobby Service's
 * long-poll timeout (408 with ?hash=), and two answers about a game that has
 * ended, since the Game Service then deletes the LS session. The board's
 * session poll that is held open at that moment gets 406 (asyncrestlib ends
 * held requests of a removed session that way), and the next one 400. Both
 * are expected only once the board shows the game as over.
 * @param {{ url: string, status?: number, error?: string }} n @param {any} probe
 */
export const expectedNetwork = (n, probe) => {
    if (n.status === 408 && /[?&]hash=/.test(n.url)) return "long-poll timeout";
    if (!probe?.splendor?.gameOver) return null;
    let path = "";
    try { path = new URL(n.url).pathname; } catch { return null; }
    if (!/^\/ls\/api\/sessions\/\d+$/.test(path)) return null;
    if (n.status === 406 && /[?&]hash=/.test(n.url)) return "LS drops the held poll of a finished game";
    if (n.status === 400) return "LS forgets a finished game";
    return null;
};

/**
 * Failures for the requested assertions ("all" for every one).
 * @param {any} probe pageProbe result
 * @param {{ console: any[], exceptions: any[], network: any[] } | null} events
 * @param {{ ready?: boolean, readyReasons?: string[] }} wait
 * @param {string[]} names
 */
export function assertProbe(probe, events, wait, names) {
    const want = new Set(names.includes("all") ? ASSERTIONS : names);
    const fails = [];
    const first = (/** @type {any} */ list) => list.items[0] || {};
    if (want.has("ready") && wait && wait.ready === false) fails.push(`ready: page never settled (${(wait.readyReasons || []).join("; ")})`);
    if (want.has("no-overflow") && probe.beyondViewport.count) fails.push(`no-overflow: ${probe.beyondViewport.count} element(s) reach past the side of the screen, e.g. ${first(probe.beyondViewport).el} (+${first(probe.beyondViewport).overRight}px right)`);
    if (want.has("no-hscroll") && probe.viewport.zoomedOut) fails.push(`no-hscroll: the page is laid out ${probe.viewport.width}px wide on a ${probe.viewport.screenWidth}px screen, so the phone shows it zoomed out${probe.viewport.metaViewport ? "" : " (no viewport meta tag)"}`);
    if (want.has("no-hscroll") && probe.document.hscroll) fails.push(`no-hscroll: document scrolls sideways (${probe.document.scrollWidth} > ${probe.document.clientWidth})`);
    if (want.has("no-unreachable") && probe.belowReach.count) fails.push(`no-unreachable: ${probe.belowReach.count} element(s) end below what can be scrolled to, e.g. ${first(probe.belowReach).el} (${first(probe.belowReach).hiddenPx}px)`);
    if (want.has("no-clipped") && probe.clippedX.count) fails.push(`no-clipped: ${probe.clippedX.count} container(s) hide content sideways, e.g. ${first(probe.clippedX).el} hides ${first(probe.clippedX).hiddenPx}px`);
    if (want.has("tap-targets") && probe.tapTargets && probe.tapTargets.small) fails.push(`tap-targets: ${probe.tapTargets.small} control(s) smaller than 44px, e.g. ${first(probe.tapTargets).el} ${first(probe.tapTargets).w}x${first(probe.tapTargets).h}`);
    if (want.has("not-covered") && probe.coveredControls.count) fails.push(`not-covered: ${probe.coveredControls.count} control(s) covered, e.g. ${first(probe.coveredControls).el} by ${first(probe.coveredControls).by}`);
    if (want.has("no-broken-images") && probe.images.broken) fails.push(`no-broken-images: ${probe.images.broken} broken, e.g. ${probe.images.brokenSrc[0]}`);
    if (events) {
        const errs = [...events.console, ...events.exceptions];
        if (want.has("no-console-errors") && errs.length) fails.push(`no-console-errors: ${errs.length}, first: ${errs[0].text}`);
        const net = events.network.filter((n) => !expectedNetwork(n, probe));
        if (want.has("no-http-errors") && net.length) fails.push(`no-http-errors: ${net.length}, first: ${net[0].status ?? net[0].error} ${net[0].url}`);
    }
    return fails;
}

/**
 * The init script that gives a tab its identity. Runs before any page
 * script, only on the target origin and only on the first document of the
 * tab (a sessionStorage marker), so a later logout or redirect by the client
 * is not papered over. It sets every identity key in place and removes only
 * keys it does not set (refreshToken; all of them for anon): it never
 * removes a key it is about to write again, so no page script can see a
 * half-written identity (displayName without accessToken makes the client
 * register a brand-new account).
 * @param {string} origin @param {{ username: string, token: string, displayName: string } | null} identity
 */
const identityScript = (origin, identity) => `(() => {
    try {
        if (location.origin !== ${JSON.stringify(origin)}) return;
        if (sessionStorage.getItem("splendorBrowserSeeded") === "1") return;
        const id = ${JSON.stringify(identity ? { displayName: identity.displayName, accessToken: identity.token, username: identity.username } : null)};
        if (id) for (const [k, v] of Object.entries(id)) localStorage.setItem(k, v);
        for (const k of ${JSON.stringify(IDENTITY_KEYS)}) if (!id || !(k in id)) localStorage.removeItem(k);
        localStorage.setItem("splendorPollWhenHidden", "1");
        sessionStorage.setItem("splendorBrowserSeeded", "1");
    } catch (e) { /* storage blocked: the page will show login */ }
})();`;

/**
 * Whether the tab really ran as the perspective it is labelled with. Two
 * signs that it did not: the stored username is another account (the client
 * registered a new one), or a seated player's board rendered the spectator
 * view (the board decides that from the username it read while rendering,
 * which a later write may have overwritten again). These are always
 * failures, with or without --assert: the shot shows someone else's view.
 * @param {any} probe @param {{ username: string, seat: number | null } | null} identity @param {boolean} redirected
 * @returns {string | null}
 */
export function identityProblem(probe, identity, redirected) {
    if (!identity || redirected || !probe?.splendor) return null;
    const sp = probe.splendor;
    if (sp.me !== identity.username) return `identity: the tab is logged in as ${sp.me ?? "nobody"}, not ${identity.username}`;
    if (identity.seat !== null && identity.seat !== undefined && sp.ready && sp.spectating) {
        return `identity: ${identity.username} is seated, but the board rendered the spectator view (the page ran under another identity)`;
    }
    return null;
}

/** Sets html[data-sp-test-insets] as soon as <html> exists. @param {string} value */
const insetsScript = (value) => `(() => {
    const set = () => { const de = document.documentElement; if (de) { de.setAttribute("data-sp-test-insets", ${JSON.stringify(value)}); return true; } return false; };
    if (!set()) new MutationObserver((_, o) => { if (set()) o.disconnect(); }).observe(document, { childList: true });
})();`;

/**
 * Wait until the readiness check passes continuously for settleMs.
 * @param {import("./browser.mjs").Page} page @param {{ waitFor?: string, timeoutMs: number, settleMs: number }} opts
 */
async function settle(page, opts) {
    const t0 = Date.now();
    if (opts.waitFor) {
        try {
            await page.waitFor(opts.waitFor, { timeoutMs: opts.timeoutMs });
            await sleep(opts.settleMs);
            return { ready: true, reasons: [], waitedOn: [], ms: Date.now() - t0 };
        } catch (err) {
            return { ready: false, reasons: [/** @type {Error} */ (err).message], waitedOn: [], ms: Date.now() - t0 };
        }
    }
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true", { timeoutMs: opts.timeoutMs }).catch(() => {});
    const expr = probeExpression(readiness);
    let okSince = 0;
    /** @type {{ ready: boolean, reasons: string[] }} */
    let state = { ready: false, reasons: ["not checked"] };
    // What the wait was blocked on, with digits folded ("3 image(s)" and
    // "2 image(s)" are one entry), so a slow shot says why it was slow.
    /** @type {Set<string>} */
    const waitedOn = new Set();
    while (Date.now() - t0 < opts.timeoutMs) {
        try { state = await page.evaluate(expr); } catch (err) { state = { ready: false, reasons: [/** @type {Error} */ (err).message] }; }
        if (state.ready) {
            okSince ||= Date.now();
            if (Date.now() - okSince >= opts.settleMs) return { ready: true, reasons: [], waitedOn: [...waitedOn], ms: Date.now() - t0 };
        } else {
            okSince = 0;
            for (const r of state.reasons) if (waitedOn.size < 12) waitedOn.add(r.replace(/\d+/g, "N"));
        }
        await sleep(120);
    }
    return { ready: false, reasons: state.reasons, waitedOn: [...waitedOn], ms: Date.now() - t0 };
}

/**
 * Tap (touch viewports) or click the centre of the first element matching selector.
 * @param {import("./browser.mjs").Page} page @param {string} selector @param {boolean} touch
 */
async function tap(page, selector, touch) {
    const box = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`--click: nothing matches ${selector}`);
    const s = page.session;
    if (touch) {
        await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
        await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
        await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
        await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
        await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
}

/** One line per shot for the terminal. @param {any} shot */
export function shotLine(shot) {
    if (shot.error) return `${shot.perspective}@${shot.viewport.name}  ERROR ${shot.error}`;
    const p = shot.probe;
    const sp = p?.splendor ?? {};
    const bits = [
        `${shot.perspective}@${shot.viewport.name}${shot.variant ? `/${shot.variant}` : ""}`,
        shot.ready ? `ready ${(shot.waitMs / 1000).toFixed(1)}s${shot.waitMs > 8000 && shot.waitedOn?.length ? ` (slow: ${shot.waitedOn.join("; ")})` : ""}`
            : `NOT READY (${shot.readyReasons.join("; ")})`,
    ];
    if (p) {
        if (shot.redirected) bits.push(`REDIRECTED to ${p.path}`);
        if (shot.identityMismatch) bits.push("IDENTITY MISMATCH");
        if (p.viewport.zoomedOut) bits.push(`ZOOMED OUT (layout ${p.viewport.width}px${p.viewport.metaViewport ? "" : ", no viewport meta"})`);
        if (sp.turn !== null && sp.turn !== undefined) bits.push(`turn=${sp.turn || "-"}${sp.myTurn ? " (mine)" : ""}`);
        if (sp.modals?.length) bits.push(`modals=${sp.modals.map((/** @type {any} */ m) => m.id).join("+")}`);
        if (sp.spectating) bits.push("spectating");
        if (sp.gameOver) bits.push(`game over: ${sp.winners ?? "?"}`);
        bits.push(`beyond=${p.beyondViewport.count} below=${p.belowReach.count} clippedX=${p.clippedX.count} covered=${p.coveredControls.count}`);
        if (p.tapTargets) bits.push(`small-taps=${p.tapTargets.small}/${p.tapTargets.interactive}`);
        if (p.images.broken) bits.push(`broken-img=${p.images.broken}`);
    }
    const ev = shot.events;
    if (ev) bits.push(`console=${ev.console.length + ev.exceptions.length} http=${ev.network.filter((/** @type {any} */ n) => !n.expected).length}`);
    if (shot.failures?.length) bits.push(`FAIL ${shot.failures.length}`);
    return `${bits.join("  ")}${shot.png ? `\n    -> ${shot.png}` : ""}`;
}

/**
 * Run a capture. Exit code: 0 ok, 1 an assertion failed or a shot errored,
 * 2 bad usage (via die).
 * @param {string[]} argv @param {{ tool: string, screenshots: boolean, report?: (manifest: any) => void }} cfg
 */
export async function run(argv, cfg) {
    /** @type {(msg: string) => never} */
    const die = (msg) => dieWith(cfg.tool, msg);
    let args;
    try { args = parseArgs(argv); } catch (err) { die(/** @type {Error} */ (err).message); }
    for (const k of Object.keys(args)) {
        if (!KNOWN.has(k)) die(`unknown option --${k} (see the header of capture.mjs)`);
        for (const v of Array.isArray(args[k]) ? args[k] : [args[k]]) {
            if (VALUED.has(k) && v === true) die(`--${k} needs a value (--${k}=...)`);
            if (FLAGS.has(k) && v !== true) die(`--${k} is a flag and takes no value`);
        }
    }
    const one = (/** @type {string} */ k) => last(args[k]);
    /** @param {string} key @param {{ fallback: number, min: number, int?: boolean, max?: number }} opts */
    const num = (key, opts) => {
        const v = numberOption(one(key), key, opts);
        if (typeof v === "string") die(v);
        return v;
    };
    const allowRemote = !!one("allow-remote");
    const screenshots = cfg.screenshots || !!one("png");

    // ---- origin, perspectives and target URL
    /** @type {any} */
    let ids = null;
    let origin;
    if (one("identities")) {
        const file = resolve(String(one("identities")));
        try { ids = JSON.parse(readFileSync(file, "utf8")); } catch (err) { die(`cannot read ${file}: ${/** @type {Error} */ (err).message}`); }
        if (ids.kind !== "splendor-browser-identities") die(`${file} is not a splendor-browser identities file (make one with seed.mjs)`);
        origin = ids.stack.baseUrl;
    } else if (one("instance")) {
        const { readInstance } = await import(new URL("stack.mjs", LIB).href);
        let inst;
        try { inst = readInstance(String(one("instance"))); } catch (err) { die(/** @type {Error} */ (err).message); }
        origin = inst.baseUrl;
    } else if (one("base-url")) {
        origin = String(one("base-url"));
    } else {
        die("pass --identities=FILE (from seed.mjs), or --instance=NAME / --base-url=URL for anonymous pages");
    }
    origin = new URL(origin).origin;
    if (!isLocalUrl(origin) && !allowRemote) die(`refusing non-local origin ${origin}; use an isolated instance, or pass --allow-remote if you really mean it`);

    const identities = ids?.identities ?? {};
    const seatedKeys = Object.keys(identities).filter((k) => identities[k].seat !== null);
    let asList = many(args.as).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    if (!asList.length) asList = seatedKeys.length ? seatedKeys : ["anon"];
    if (asList.includes("all")) asList = [...Object.keys(identities), ...asList.filter((a) => a !== "all" && !(a in identities))];
    asList = [...new Set(asList)];
    for (const a of asList) if (a !== "anon" && !(a in identities)) die(`no identity "${a}" in the identities file (have: ${Object.keys(identities).join(", ") || "none"}, plus anon)`);

    let path;
    if (one("path")) path = String(one("path"));
    else {
        const pageName = String(one("page") || (ids?.game?.launched ? "board" : "lobby"));
        if (pageName === "board") {
            if (!ids?.game?.launched) die("--page=board needs an identities file with a launched game");
            path = `${ids.game.boardPath}?sessionId=${ids.game.sessionId}`;
        } else if (pageName in PAGES) path = PAGES[/** @type {keyof typeof PAGES} */ (pageName)];
        else die(`unknown --page ${pageName}; use board, ${Object.keys(PAGES).join(", ")} or --path`);
    }
    if (!path.startsWith("/")) die("--path must start with /");
    const url = `${origin}${path}`;
    const wantPath = new URL(url).pathname;

    const dpr = one("dpr") === undefined ? undefined : num("dpr", { fallback: 0, min: 0.1, max: 4 });
    /** @type {import("./browser.mjs").Viewport[]} */
    let viewports = [];
    try {
        viewports = one("matrix") ? Object.keys(VIEWPORTS).map((k) => ({ ...VIEWPORTS[k], ...(dpr ? { dpr } : {}) }))
            : parseViewportList(many(args.vp).length ? many(args.vp) : ["phone,desktop"], { dpr });
    } catch (err) { die(/** @type {Error} */ (err).message); }
    if (!viewports.length) die("--vp lists no viewport");

    const modals = String(one("modals") || "keep");
    if (!["keep", "close", "both"].includes(modals)) die("--modals must be keep, close or both");
    const asserts = many(args.assert).flatMap((s) => s.split(",")).filter(Boolean);
    for (const a of asserts) if (a !== "all" && !(/** @type {readonly string[]} */ (ASSERTIONS)).includes(a)) die(`unknown --assert ${a}; use ${ASSERTIONS.join(", ")} or all`);
    const timeoutMs = num("timeout", { fallback: 30_000, min: 100 });
    const settleMs = num("settle", { fallback: 700, min: 0 });
    const jobs = Math.min(8, num("jobs", { fallback: 3, min: 1, int: true }));
    const waitFor = one("wait-for") ? String(one("wait-for")) : undefined;
    const insets = one("insets") === undefined ? null : (one("insets") === true ? "1" : String(one("insets")));
    const clicks = many(args.click);
    const evals = many(args.eval);
    const full = !!one("full");
    const label = one("label") ? String(one("label")).replace(/[^A-Za-z0-9_.-]+/g, "_") : "";
    const outDir = resolve(String(one("out-dir") || join(tmpdir(), "splendor-browser", `${cfg.tool.replace(/\.mjs$/, "")}-${stamp()}`)));
    mkdirSync(outDir, { recursive: true });

    // ---- browser
    const browser = await getBrowser({
        cdp: one("cdp") ? String(one("cdp")) : undefined,
        chrome: one("chrome") ? String(one("chrome")) : undefined,
        profileRoot: one("profile-root") ? String(one("profile-root")) : undefined,
        keepProfile: !!one("keep-profile"),
        noProxy: isLocalUrl(origin),
        headful: !!one("headful"),
    });
    const manifest = {
        tool: cfg.tool,
        createdAt: new Date().toISOString(),
        origin, url: url.replace(/([?&](access_token|migrate)=)[^&]+/g, "$1***"),
        sessionId: ids?.game?.sessionId ?? null, version: ids?.game?.version ?? null,
        players: ids?.game?.players ?? null, insets,
        browser: browser.version?.product ?? null, mode: browser.mode,
        outDir,
        /** @type {any[]} */ shots: [],
    };
    let failed = 0;
    /** @type {any[][]} */
    const results = [];
    try {
        const tasks = asList.flatMap((who) => viewports.map((vp) => ({ who, vp })));

        /** @param {{ who: string, vp: import("./browser.mjs").Viewport }} task */
        const runTask = async ({ who, vp }) => {
            const identity = who === "anon" ? null : identities[who];
            // A context per tab, not per perspective: tabs of one context
            // share localStorage and run at the same time.
            const context = await browser.newContext();
            /** @type {import("./browser.mjs").Page | null} */
            let page = null;
            const shots = [];
            try {
                page = await browser.newPage(context);
                await page.emulate(vp);
                await page.addInitScript(identityScript(origin, identity));
                if (insets !== null) await page.addInitScript(insetsScript(insets));
                page.clearEvents();
                await page.goto(url, { timeoutMs });
                let wait = await settle(page, { waitFor, timeoutMs, settleMs });
                for (const sel of clicks) { await tap(page, sel, vp.mobile); wait = await settle(page, { waitFor: undefined, timeoutMs, settleMs }); }
                for (const expr of evals) { await page.evaluate(expr); wait = await settle(page, { waitFor: undefined, timeoutMs, settleMs }); }
                const variants = modals === "both" ? ["", "nomodal"] : [modals === "close" ? "nomodal" : ""];
                for (const variant of variants) {
                    if (variant === "nomodal") {
                        await page.evaluate(`document.querySelectorAll(".modal.show").forEach((m) => m.classList.remove("show")); true`);
                        await sleep(150);
                    }
                    const probe = await page.evaluate(probeExpression(pageProbe, { touch: vp.mobile }), { commandLineApi: true });
                    const redirected = probe.path !== wantPath;
                    const ready = wait.ready && !redirected;
                    const readyReasons = redirected ? [...wait.reasons, `the client redirected to ${probe.path} ${identity ? "(identity rejected?)" : "(expected with no identity)"}`] : wait.reasons;
                    const events = {
                        console: [...page.events.console], exceptions: [...page.events.exceptions],
                        network: page.events.network.map((n) => ({ ...n, url: n.url.replace(/([?&]access_token=)[^&]+/g, "$1***"), expected: expectedNetwork(n, probe) })),
                    };
                    let png = null;
                    if (screenshots) {
                        png = join(outDir, `${label ? `${label}-` : ""}${who}-${vp.name}${variant ? `-${variant}` : ""}${full ? "-full" : ""}.png`);
                        writeFileSync(png, await page.screenshot({ full }));
                    }
                    const failures = asserts.length ? assertProbe(probe, events, { ready, readyReasons }, asserts) : [];
                    const wrongIdentity = identityProblem(probe, identity, redirected);
                    if (wrongIdentity) failures.unshift(wrongIdentity);
                    if (failures.length) failed++;
                    const shot = {
                        perspective: who, username: identity?.username ?? null, viewport: vp, variant: variant || null,
                        png, ready, redirected, identityMismatch: wrongIdentity, readyReasons, waitedOn: wait.waitedOn, waitMs: wait.ms, probe, events, failures,
                    };
                    shots.push(shot);
                    process.stdout.write(`${shotLine(shot)}\n`);
                    for (const f of failures) process.stdout.write(`    FAIL ${f}\n`);
                }
            } catch (err) {
                failed++;
                const shot = { perspective: who, viewport: vp, error: /** @type {Error} */ (err).message };
                shots.push(shot);
                process.stdout.write(`${shotLine(shot)}\n`);
            } finally {
                if (page) await page.close();
                await browser.disposeContext(context);
            }
            return shots;
        };

        let next = 0;
        const worker = async () => {
            while (next < tasks.length) {
                const i = next++;
                results[i] = await runTask(tasks[i]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
    } finally {
        await browser.close();
    }
    manifest.shots = results.flat();
    if (!manifest.shots.length) {
        failed++;
        process.stderr.write(`${cfg.tool}: no shot was taken, so nothing was checked\n`);
    }
    const manifestFile = join(outDir, `manifest${label ? `-${label}` : ""}.json`);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    if (cfg.report) cfg.report(manifest);
    if (one("json")) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`manifest: ${manifestFile}\n`);
    process.exitCode = failed ? 1 : 0;
    return manifest;
}
