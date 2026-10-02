// @ts-check
/**
 * Get a browser to drive over CDP, and pages with real device emulation.
 *
 * Default: launch a PRIVATE headless Google Chrome with a throwaway profile
 * (--user-data-dir under the system temp dir, or under --profile-root), on a
 * port the browser picks itself (--remote-debugging-port=0, read back from
 * DevToolsActivePort). It never touches the user's own browser, needs no
 * screen and can run next to other sessions.
 *
 * Attach mode (--cdp=URL): use a browser that already listens for CDP. Even
 * then every tab gets a fresh browser context (Target.createBrowserContext)
 * and new targets; existing tabs are never touched and the browser is never
 * closed, only the contexts this process created are disposed.
 *
 * Shutdown: Browser.close, wait for the process to exit, then kill leftovers
 * by PID, found by filtering a ps listing IN CODE on the literal, validated
 * --user-data-dir argument (never pgrep -f with a variable). On macOS Chrome
 * also starts helpers without that argument (chrome_crashpad_handler and
 * GoogleUpdater) that outlive it for minutes or days. Chrome's stderr goes to
 * a private file in the profile, every descendant inherits it, and lsof on
 * that exact file finds them too. A file, not a pipe: an inherited pipe would
 * keep this Node process from exiting.
 *
 * The same shutdown runs on SIGINT, SIGTERM and SIGHUP (tmux kill-session, a
 * closed terminal). A write error on stdout or stderr (EPIPE when the output
 * is piped to `head`) is swallowed, so the run carries on and still cleans
 * up. Anything else that ends the process early (an uncaught exception,
 * process.exit) triggers a synchronous SIGKILL sweep from the 'exit' hook.
 * Only SIGKILL of this Node process skips all of that; for that case every
 * profile records its owner PID, and the next launch sweeps any profile under
 * the same root whose owner is gone.
 */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CdpConnection, CdpError, sleep } from "./cdp.mjs";

export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE_PREFIX = "splendor-browser-";
/** Written into every profile we launch: { pid, keepProfile, createdAt }. */
const OWNER_NAME = "splendor-browser-owner.json";

const UA = {
    ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
};

/**
 * @typedef {object} Viewport
 * @property {string} name
 * @property {number} width   CSS px
 * @property {number} height  CSS px
 * @property {number} dpr     device pixel ratio
 * @property {boolean} mobile mobile emulation: touch, mobile UA, meta viewport honoured
 * @property {keyof typeof UA} [ua]
 * @property {boolean} [landscape]
 */

/** Viewport presets. Mobile presets get touch emulation and a mobile user agent. */
export const VIEWPORTS = /** @type {Record<string, Viewport>} */ ({
    se: { name: "se", width: 375, height: 667, dpr: 2, mobile: true, ua: "ios" },
    phone: { name: "phone", width: 390, height: 844, dpr: 2, mobile: true, ua: "ios" },
    android: { name: "android", width: 360, height: 800, dpr: 2, mobile: true, ua: "android" },
    landscape: { name: "landscape", width: 844, height: 390, dpr: 2, mobile: true, ua: "ios", landscape: true },
    tablet: { name: "tablet", width: 820, height: 1180, dpr: 2, mobile: true, ua: "ipad" },
    desktop: { name: "desktop", width: 1280, height: 850, dpr: 1, mobile: false },
    wide: { name: "wide", width: 1920, height: 1080, dpr: 1, mobile: false },
});

/**
 * A preset name, or a custom size "WxH[@dpr][,mobile]". A custom size is a
 * desktop viewport (no touch, DPR 1) unless ",mobile" is added, which turns
 * on the same emulation as the phone presets (touch, mobile user agent, DPR 2
 * by default, landscape when W > H).
 * @param {string} spec @param {{ dpr?: number }} [opts] dpr overrides every viewport
 * @returns {Viewport}
 */
export function parseViewport(spec, opts = {}) {
    const s = spec.trim();
    let vp = VIEWPORTS[s];
    if (!vp) {
        const m = /^(\d{2,5})x(\d{2,5})(?:@(\d+(?:\.\d+)?))?(,mobile)?$/.exec(s);
        if (!m) throw new Error(`unknown viewport ${JSON.stringify(spec)}: use one of ${Object.keys(VIEWPORTS).join(", ")} or WxH[@dpr][,mobile]`);
        const width = Number(m[1]);
        const height = Number(m[2]);
        const mobile = !!m[4];
        vp = {
            name: `${width}x${height}${m[3] ? `@${m[3]}` : ""}${mobile ? "-mobile" : ""}`, width, height,
            dpr: m[3] ? Number(m[3]) : (mobile ? 2 : 1), mobile,
            ua: mobile ? (Math.min(width, height) >= 700 ? "ipad" : "ios") : undefined,
            landscape: mobile && width > height,
        };
    }
    if (!(vp.dpr > 0 && vp.dpr <= 4)) throw new Error(`viewport ${JSON.stringify(spec)}: device pixel ratio must be in (0, 4]`);
    return opts.dpr ? { ...vp, dpr: opts.dpr } : { ...vp };
}

/**
 * Parse --vp values. Items are comma separated, and a bare "mobile" item
 * belongs to the custom size before it, so "phone,390x700,mobile,desktop"
 * is three viewports.
 * @param {string[]} values @param {{ dpr?: number }} [opts]
 */
export function parseViewportList(values, opts = {}) {
    /** @type {string[]} */
    const specs = [];
    for (const item of values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean)) {
        if (item === "mobile") {
            if (!specs.length || !/^\d+x\d+(@[\d.]+)?$/.test(specs[specs.length - 1])) throw new Error('",mobile" must follow a custom WxH size');
            specs[specs.length - 1] += ",mobile";
        } else specs.push(item);
    }
    return specs.map((s) => parseViewport(s, opts));
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** @param {string} url */
export const isLocalUrl = (url) => {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
};

/**
 * The path a profile dir must look like before anything is killed or
 * deleted because of it: absolute, created by us (prefix), no odd characters.
 * @param {string} dir
 */
function assertOwnProfileDir(dir) {
    if (!isAbsolute(dir) || dir.length < 12 || /[\s"'`$\\\n]/.test(dir) || !dir.split("/").pop()?.startsWith(PROFILE_PREFIX)) {
        throw new Error(`refusing to manage profile dir ${JSON.stringify(dir)}: not an absolute ${PROFILE_PREFIX}* path`);
    }
}

/**
 * PIDs whose command line carries exactly this --user-data-dir argument.
 * Filters `ps` output in code on a literal; never a regex or pgrep -f.
 * @param {string} dirArg the exact value passed to Chrome
 */
export function profilePids(dirArg) {
    assertOwnProfileDir(dirArg);
    const needle = `--user-data-dir=${dirArg}`;
    const out = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const pids = [];
    for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const cmd = m[2];
        const at = cmd.indexOf(needle);
        if (at < 0) continue;
        const after = cmd.charAt(at + needle.length);
        if (after !== "" && after !== " ") continue; // a longer path that merely starts with ours
        const pid = Number(m[1]);
        if (pid !== process.pid) pids.push(pid);
    }
    return pids;
}

/** Chrome's stderr, inside the profile; every process Chrome spawns inherits it. */
const STDERR_NAME = "splendor-browser-stderr.log";

/**
 * PIDs that hold this profile's stderr file open: Chrome and everything it
 * spawned, including helpers that carry no --user-data-dir argument.
 * @param {string} profileDir
 */
export function stderrHolderPids(profileDir) {
    assertOwnProfileDir(profileDir);
    const file = join(profileDir, STDERR_NAME);
    if (!existsSync(file)) return [];
    const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
    let out = "";
    try {
        out = execFileSync(lsof, ["-t", "--", file], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
        out = String(/** @type {any} */ (err).stdout || ""); // lsof exits 1 when nobody holds it
    }
    return out.split("\n").map((l) => Number(l.trim())).filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
}

/** Everything this profile's Chrome left running. @param {string} profileDir */
const ownedPids = (profileDir) => [...new Set([...profilePids(profileDir), ...stderrHolderPids(profileDir)])];

/** "PID name" for the log. @param {number[]} pids */
const describePids = (pids) => {
    try {
        return execFileSync("/bin/ps", ["-o", "pid=,comm=", "-p", pids.join(",")], { encoding: "utf8" })
            .split("\n").filter(Boolean).map((l) => l.trim().replace(/^(\d+)\s+.*\/([^/]+)$/, "$1 $2")).join(", ");
    } catch { return pids.join(" "); }
};

/** @param {string} msg */
const note = (msg) => { try { process.stderr.write(`[splendor-browser] ${msg}\n`); } catch { /* stderr gone */ } };

let stdioGuarded = false;
/**
 * Keep a broken stdout or stderr from killing the process before it cleans
 * up. `probe.mjs | head -3` closes the pipe after three lines, and the next
 * write raises EPIPE as an 'error' event, which crashes Node when nobody
 * listens. A closed terminal (SIGHUP) raises EIO the same way. The output is
 * lost either way; the run goes on and the browser is still closed.
 */
export function guardStdio() {
    if (stdioGuarded) return;
    stdioGuarded = true;
    for (const stream of [process.stdout, process.stderr]) stream.on("error", () => { /* reader went away */ });
}

export class Browser {
    /**
     * @param {CdpConnection} conn
     * @param {{ mode: "launch" | "attach", child?: import("node:child_process").ChildProcess, profileDir?: string, ownsProfile?: boolean, keepProfile?: boolean, version?: any, exitHook?: () => void }} info
     */
    constructor(conn, info) {
        this.conn = conn;
        this.mode = info.mode;
        this.child = info.child;
        this.profileDir = info.profileDir;
        this.ownsProfile = !!info.ownsProfile;
        this.keepProfile = !!info.keepProfile;
        this.version = info.version;
        this.exitHook = info.exitHook;
        /** @type {Set<string>} */
        this.contexts = new Set();
        /** @type {Set<Page>} */
        this.pages = new Set();
        this.closing = null;
    }

    /** A fresh, isolated browser context (own cookies and storage). */
    async newContext() {
        const { browserContextId } = await this.conn.send("Target.createBrowserContext", { disposeOnDetach: true });
        this.contexts.add(browserContextId);
        return browserContextId;
    }

    /**
     * Dispose a context made by newContext, closing its tabs. Errors are
     * ignored: the browser may already be gone.
     * @param {string} contextId
     */
    async disposeContext(contextId) {
        if (!this.contexts.delete(contextId)) return;
        for (const page of [...this.pages]) if (page.contextId === contextId) await page.close().catch(() => {});
        await this.conn.send("Target.disposeBrowserContext", { browserContextId: contextId }, { timeoutMs: 5000 }).catch(() => {});
    }

    /**
     * A new page (tab) in `contextId`, attached in flat mode.
     * @param {string} contextId
     */
    async newPage(contextId) {
        const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
        const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
        const page = new Page(this, targetId, sessionId, contextId);
        this.pages.add(page);
        await page.init();
        return page;
    }

    /** Close everything this process created. Safe to call twice. */
    close() {
        this.closing ??= this.#close();
        return this.closing;
    }

    async #close() {
        for (const page of [...this.pages]) await page.close().catch(() => {});
        if (this.mode === "attach") {
            for (const id of this.contexts) await this.conn.send("Target.disposeBrowserContext", { browserContextId: id }, { timeoutMs: 5000 }).catch(() => {});
            this.conn.close();
            return;
        }
        await this.conn.send("Browser.close", {}, { timeoutMs: 5000 }).catch(() => {});
        this.conn.close();
        const child = this.child;
        if (child && child.exitCode === null && child.signalCode === null) {
            await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
        }
        if (this.profileDir) await sweepProfile(this.profileDir, { remove: this.ownsProfile && !this.keepProfile, graceMs: 3000 });
        if (this.exitHook) process.removeListener("exit", this.exitHook);
    }
}

/**
 * Kill every process still running from this profile, then delete it.
 * Every signal goes to PIDs from a FRESH listing (ps filtered on the literal
 * profile argument, plus lsof on the profile's own stderr file), so a PID
 * that exited and was reused meanwhile is never hit.
 * @param {string} profileDir @param {{ remove?: boolean, graceMs?: number }} [opts]
 */
export async function sweepProfile(profileDir, opts = {}) {
    // Renderers, GPU and network helpers usually exit on their own within a
    // second of the browser process; wait for that (cheap ps checks only).
    const graceEnd = Date.now() + (opts.graceMs ?? 0);
    while (profilePids(profileDir).length && Date.now() < graceEnd) await sleep(150);
    let pids = ownedPids(profileDir);
    if (pids.length) {
        note(`stopping what Chrome left running for ${profileDir}: ${describePids(pids)} (SIGTERM)`);
        for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && pids.length) {
            await sleep(250);
            pids = ownedPids(profileDir);
        }
        if (pids.length) {
            note(`SIGKILL to ${describePids(pids)}`);
            for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
            await sleep(300);
        }
    }
    const left = ownedPids(profileDir);
    if (left.length) note(`WARNING: still alive for ${profileDir}: ${describePids(left)}`);
    if (opts.remove) {
        assertOwnProfileDir(profileDir);
        rmSync(profileDir, { recursive: true, force: true });
    }
    return left;
}

/**
 * The last-resort cleanup for a process that is exiting without having
 * closed its browser. Only synchronous work is possible in an 'exit'
 * handler, so everything still running from the profile gets SIGKILL (PIDs
 * from a fresh listing, as in sweepProfile) and the profile is deleted.
 * @param {string} profileDir @param {{ remove: boolean, child?: import("node:child_process").ChildProcess }} opts
 */
function sweepProfileNow(profileDir, opts) {
    try { if (opts.child && opts.child.exitCode === null && opts.child.signalCode === null) opts.child.kill("SIGKILL"); } catch { /* gone */ }
    try {
        for (const pid of ownedPids(profileDir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    } catch { /* ps or lsof failed: nothing more we can do here */ }
    if (opts.remove) {
        try { assertOwnProfileDir(profileDir); rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/** Whether a process with this PID exists (EPERM: it exists, owned by someone else). @param {number} pid */
const pidAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return /** @type {any} */ (err).code === "EPERM"; }
};

/**
 * Sweep profiles under `root` that an earlier run left behind: those whose
 * owner file names a PID that no longer exists (that run was SIGKILLed).
 * Profiles without an owner file are never touched: they may belong to a run
 * that has just created its directory, or predate owner files. A profile
 * kept with --keep-profile loses only its processes and its owner file.
 * @param {string} root an existing directory (realpath)
 */
export async function sweepStaleProfiles(root) {
    /** @type {string[]} */
    let names = [];
    try { names = readdirSync(root).filter((n) => n.startsWith(PROFILE_PREFIX)); } catch { return []; }
    const swept = [];
    for (const name of names) {
        const dir = join(root, name);
        /** @type {any} */
        let owner = null;
        try { owner = JSON.parse(readFileSync(join(dir, OWNER_NAME), "utf8")); } catch { continue; }
        const pid = Number(owner?.pid);
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pidAlive(pid)) continue;
        try { assertOwnProfileDir(dir); } catch { continue; }
        note(`sweeping ${dir}, left behind by PID ${pid}, which is gone`);
        await sweepProfile(dir, { remove: !owner.keepProfile }).catch(() => {});
        if (owner.keepProfile) rmSync(join(dir, OWNER_NAME), { force: true });
        swept.push(dir);
    }
    return swept;
}

export async function launchChrome(opts = {}) {
    const chrome = opts.chrome || process.env.SPLENDOR_CHROME || DEFAULT_CHROME;
    if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; pass --chrome=PATH or set SPLENDOR_CHROME`);
    const root = resolve(opts.profileRoot || tmpdir());
    mkdirSync(root, { recursive: true });
    // realpath so the argument Chrome sees matches what ps prints (/var -> /private/var).
    const realRoot = realpathSync(root);
    await sweepStaleProfiles(realRoot);
    const profileDir = mkdtempSync(join(realRoot, PROFILE_PREFIX));
    assertOwnProfileDir(profileDir);
    writeFileSync(join(profileDir, OWNER_NAME), `${JSON.stringify({ pid: process.pid, keepProfile: !!opts.keepProfile, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    const args = [
        ...(opts.headless === false ? [] : ["--headless=new"]),
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--hide-scrollbars", "--mute-audio", "--use-mock-keychain",
        "--disable-background-networking", "--disable-sync", "--disable-component-update",
        "--disable-default-apps", "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
        "--disable-features=Translate,MediaRouter,OptimizationHints",
        opts.noProxy === false ? "--proxy-bypass-list=127.0.0.1;localhost;[::1]" : "--no-proxy-server",
        "--window-size=1280,850",
        ...(opts.extraArgs || []),
        "about:blank",
    ];
    const stderrFile = join(profileDir, STDERR_NAME);
    const stderrFd = openSync(stderrFile, "w", 0o600);
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", stderrFd], detached: false });
    closeSync(stderrFd); // only Chrome and its descendants hold it now
    const stderrTail = () => { try { return readFileSync(stderrFile, "utf8").slice(-2000); } catch { return "(no stderr)"; } };
    const killOnExit = () => { try { if (child.exitCode === null) child.kill("SIGKILL"); } catch { /* ignore */ } };
    const exitHook = () => sweepProfileNow(profileDir, { remove: !opts.keepProfile, child });
    process.once("exit", exitHook);

    const portFile = join(profileDir, "DevToolsActivePort");
    const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
    let wsUrl = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        if (existsSync(portFile)) {
            const [port, path] = readFileSync(portFile, "utf8").split("\n");
            if (port && path) { wsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`; break; }
        }
        await sleep(100);
    }
    if (!wsUrl) {
        killOnExit();
        await sleep(300);
        const tail = stderrTail();
        await sweepProfile(profileDir, { remove: !opts.keepProfile }).catch(() => {});
        process.removeListener("exit", exitHook);
        throw new Error(`Chrome did not start (exit ${child.exitCode}). stderr:\n${tail}`);
    }
    const conn = await CdpConnection.open(wsUrl);
    const version = await conn.send("Browser.getVersion");
    const browser = new Browser(conn, { mode: "launch", child, profileDir, ownsProfile: true, keepProfile: opts.keepProfile, version, exitHook });
    return browser;
}

/**
 * Attach to a browser already listening for CDP. Accepts http://host:port
 * (reads /json/version) or a ws:// browser endpoint.
 * @param {string} cdpUrl
 */
export async function attachBrowser(cdpUrl) {
    let wsUrl = cdpUrl;
    if (/^https?:/.test(cdpUrl)) {
        const resp = await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`${cdpUrl}/json/version answered ${resp.status}`);
        wsUrl = (await resp.json()).webSocketDebuggerUrl;
    }
    if (!/^wss?:\/\//.test(wsUrl)) throw new Error(`not a CDP endpoint: ${cdpUrl}`);
    const conn = await CdpConnection.open(wsUrl);
    const version = await conn.send("Browser.getVersion");
    return new Browser(conn, { mode: "attach", version });
}

/**
 * @param {{ cdp?: string, chrome?: string, profileRoot?: string, keepProfile?: boolean, noProxy?: boolean, headful?: boolean }} opts
 */
export async function getBrowser(opts) {
    guardStdio();
    const browser = opts.cdp ? await attachBrowser(opts.cdp) : await launchChrome({
        chrome: opts.chrome, profileRoot: opts.profileRoot, keepProfile: opts.keepProfile,
        noProxy: opts.noProxy, headless: !opts.headful,
    });
    // The first signal closes the browser (bounded: about 20 s at worst) and
    // exits 128 + signal number. Repeats are ignored while that runs, except
    // a second Ctrl-C, which exits at once (the 'exit' hook still SIGKILLs
    // what it can find).
    const codes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    let closing = false;
    const shutdown = (/** @type {keyof typeof codes} */ sig) => {
        if (closing) {
            if (sig === "SIGINT") { note("second SIGINT: exiting without waiting"); process.exit(codes[sig]); }
            note(`${sig}: already closing the browser`);
            return;
        }
        closing = true;
        note(`${sig}: closing the browser`);
        browser.close().finally(() => process.exit(codes[sig]));
    };
    for (const sig of /** @type {(keyof typeof codes)[]} */ (Object.keys(codes))) process.on(sig, shutdown);
    return browser;
}

/**
 * @typedef {object} PageEvents
 * @property {Array<{ type: string, text: string, url?: string }>} console   console.error/assert and Log errors
 * @property {Array<{ text: string, url?: string, line?: number }>} exceptions
 * @property {Array<{ url: string, status?: number, error?: string, type?: string, method?: string }>} network failed requests and responses >= 400
 */

export class Page {
    /** @param {Browser} browser @param {string} targetId @param {string} sessionId @param {string} contextId */
    constructor(browser, targetId, sessionId, contextId) {
        this.browser = browser;
        this.targetId = targetId;
        this.contextId = contextId;
        this.session = browser.conn.session(sessionId);
        /** @type {PageEvents} */
        this.events = { console: [], exceptions: [], network: [] };
        /** @type {Map<string, { url: string, method: string }>} */
        this.requests = new Map();
        this.closed = false;
    }

    async init() {
        const s = this.session;
        s.on("Runtime.consoleAPICalled", (p) => {
            if (p.type !== "error" && p.type !== "assert") return;
            const text = (p.args || []).map((/** @type {any} */ a) => a.value ?? a.description ?? a.type).join(" ");
            this.events.console.push({ type: `console.${p.type}`, text: text.slice(0, 500), url: p.stackTrace?.callFrames?.[0]?.url });
        });
        s.on("Runtime.exceptionThrown", (p) => {
            const d = p.exceptionDetails || {};
            this.events.exceptions.push({ text: String(d.exception?.description || d.text || "exception").split("\n").slice(0, 4).join(" | ").slice(0, 600), url: d.url, line: d.lineNumber });
        });
        s.on("Log.entryAdded", (p) => {
            const e = p.entry || {};
            // "Failed to load resource" lines repeat what the network list already has.
            if (e.level !== "error" || e.source === "network") return;
            this.events.console.push({ type: `log.${e.source}`, text: String(e.text).slice(0, 500), url: e.url });
        });
        s.on("Network.requestWillBeSent", (p) => {
            this.requests.set(p.requestId, { url: p.request.url, method: p.request.method });
        });
        s.on("Network.responseReceived", (p) => {
            if (p.response.status >= 400) {
                const req = this.requests.get(p.requestId);
                this.events.network.push({ url: p.response.url, status: p.response.status, type: p.type, method: req?.method });
            }
        });
        s.on("Network.loadingFailed", (p) => {
            if (p.canceled) return; // aborted by navigation or page close, e.g. a pending long-poll
            const req = this.requests.get(p.requestId);
            this.events.network.push({ url: req?.url ?? "?", error: p.errorText, type: p.type, method: req?.method });
        });
        await s.send("Page.enable");
        await s.send("Runtime.enable");
        await s.send("Network.enable");
        await s.send("Log.enable");
        await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    }

    /** Reset the collected console, exception and network events. */
    clearEvents() {
        this.events = { console: [], exceptions: [], network: [] };
    }

    /** @param {Viewport} vp */
    async emulate(vp) {
        const s = this.session;
        await s.send("Emulation.setDeviceMetricsOverride", {
            width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile,
            screenWidth: vp.width, screenHeight: vp.height,
            screenOrientation: vp.landscape ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 },
        });
        await s.send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
        if (vp.mobile && vp.ua) {
            await s.send("Emulation.setUserAgentOverride", {
                userAgent: UA[vp.ua],
                platform: vp.ua === "android" ? "Linux armv8l" : vp.ua === "ipad" ? "iPad" : "iPhone",
            });
        }
    }

    /**
     * Run `source` in every new document of this tab before any page script.
     * @param {string} source
     */
    addInitScript(source) {
        return this.session.send("Page.addScriptToEvaluateOnNewDocument", { source });
    }

    /**
     * Navigate and wait for the load event.
     * @param {string} url @param {{ timeoutMs?: number }} [opts]
     */
    async goto(url, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const loaded = this.session.once("Page.loadEventFired", { timeoutMs });
        const res = await this.session.send("Page.navigate", { url });
        if (res.errorText) { loaded.catch(() => {}); throw new CdpError(`navigation to ${url} failed: ${res.errorText}`); }
        await loaded;
    }

    /** @param {string} expression @param {{ timeoutMs?: number, commandLineApi?: boolean }} [opts] */
    evaluate(expression, opts) {
        return this.session.evaluate(expression, opts);
    }

    /** @param {string} expression @param {{ timeoutMs?: number, intervalMs?: number }} [opts] */
    waitFor(expression, opts) {
        return this.session.waitFor(expression, opts);
    }

    /**
     * PNG of the viewport, or of the whole document with full=true.
     * @param {{ full?: boolean }} [opts]
     * @returns {Promise<Buffer>}
     */
    async screenshot(opts = {}) {
        await this.session.send("Page.bringToFront").catch(() => {});
        /** @type {Record<string, unknown>} */
        const params = { format: "png", fromSurface: true };
        if (opts.full) {
            const m = await this.session.send("Page.getLayoutMetrics");
            const size = m.cssContentSize || m.contentSize;
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        }
        const { data } = await this.session.send("Page.captureScreenshot", params, { timeoutMs: 60_000 });
        return Buffer.from(data, "base64");
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.browser.pages.delete(this);
        await this.browser.conn.send("Target.closeTarget", { targetId: this.targetId }, { timeoutMs: 5000 }).catch(() => {});
    }
}
