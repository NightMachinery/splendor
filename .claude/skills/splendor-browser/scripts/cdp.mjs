// @ts-check
/**
 * A minimal Chrome DevTools Protocol (CDP) client over Node's built-in
 * WebSocket (Node >= 22). No dependencies.
 *
 *   const conn = await CdpConnection.open(wsUrl);
 *   await conn.send("Target.getTargets");          // browser-level command
 *   const page = conn.session(sessionId);          // flat-mode target session
 *   await page.send("Page.enable");
 *   page.on("Page.loadEventFired", () => ...);
 *   await page.evaluate("document.title");
 *   await page.waitFor("document.readyState === 'complete'", { timeoutMs: 5000 });
 *
 * Every send() rejects on a CDP error reply, on timeout and when the socket
 * closes, so a failed command can never turn into an undefined result that
 * crashes three lines later.
 */

export class CdpError extends Error {
    /** @param {string} message @param {{ method?: string, code?: number, data?: unknown }} [info] */
    constructor(message, info = {}) {
        super(message);
        this.name = "CdpError";
        this.method = info.method;
        this.code = info.code;
        this.data = info.data;
    }
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {(params: any, sessionId?: string) => void} Listener
 */

export class CdpConnection {
    /**
     * Connect to a browser or page WebSocket endpoint.
     * @param {string} wsUrl e.g. ws://127.0.0.1:PORT/devtools/browser/UUID
     * @param {{ timeoutMs?: number, commandTimeoutMs?: number }} [opts]
     */
    static async open(wsUrl, opts = {}) {
        const ws = new WebSocket(wsUrl);
        const timeoutMs = opts.timeoutMs ?? 10_000;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                try { ws.close(); } catch { /* ignore */ }
                reject(new CdpError(`CDP connect to ${wsUrl} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            ws.addEventListener("open", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
            ws.addEventListener("error", (ev) => {
                clearTimeout(timer);
                reject(new CdpError(`CDP connect to ${wsUrl} failed: ${/** @type {any} */ (ev)?.message ?? "socket error"}`));
            }, { once: true });
        });
        return new CdpConnection(ws, opts.commandTimeoutMs ?? 30_000);
    }

    /** @param {WebSocket} ws @param {number} commandTimeoutMs */
    constructor(ws, commandTimeoutMs) {
        this.ws = ws;
        this.commandTimeoutMs = commandTimeoutMs;
        this.nextId = 1;
        /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout, method: string }>} */
        this.pending = new Map();
        /** @type {Map<string, Set<Listener>>} key: method or method@sessionId */
        this.listeners = new Map();
        this.closed = false;
        ws.addEventListener("message", (ev) => this.#onMessage(ev));
        ws.addEventListener("close", () => this.#onClose("socket closed"));
        ws.addEventListener("error", () => this.#onClose("socket error"));
    }

    /** @param {MessageEvent} ev */
    #onMessage(ev) {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (typeof msg.id === "number") {
            const entry = this.pending.get(msg.id);
            if (!entry) return;
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
                entry.reject(new CdpError(`${entry.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`,
                    { method: entry.method, code: msg.error.code, data: msg.error.data }));
            } else {
                entry.resolve(msg.result ?? {});
            }
            return;
        }
        if (typeof msg.method === "string") {
            for (const key of [msg.method, `${msg.method}@${msg.sessionId ?? ""}`]) {
                const set = this.listeners.get(key);
                if (!set) continue;
                for (const fn of [...set]) {
                    try { fn(msg.params ?? {}, msg.sessionId); } catch (err) { console.error(`CDP listener for ${key} threw:`, err); }
                }
            }
        }
    }

    /** @param {string} why */
    #onClose(why) {
        if (this.closed) return;
        this.closed = true;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new CdpError(`${entry.method}: ${why} before a reply`, { method: entry.method }));
        }
        this.pending.clear();
    }

    /**
     * Send one command. Rejects on a CDP error, on timeout and on close.
     * @param {string} method @param {Record<string, unknown>} [params]
     * @param {{ sessionId?: string, timeoutMs?: number }} [opts]
     * @returns {Promise<any>}
     */
    send(method, params = {}, opts = {}) {
        if (this.closed) return Promise.reject(new CdpError(`${method}: connection is closed`, { method }));
        const id = this.nextId++;
        const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpError(`${method}: no reply within ${timeoutMs} ms`, { method }));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            /** @type {Record<string, unknown>} */
            const msg = { id, method, params };
            if (opts.sessionId) msg.sessionId = opts.sessionId;
            try {
                this.ws.send(JSON.stringify(msg));
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new CdpError(`${method}: send failed: ${/** @type {Error} */ (err).message}`, { method }));
            }
        });
    }

    /**
     * Subscribe to an event; returns an unsubscribe function.
     * @param {string} method @param {Listener} fn @param {string} [sessionId] only events of this session
     */
    on(method, fn, sessionId) {
        const key = sessionId === undefined ? method : `${method}@${sessionId}`;
        let set = this.listeners.get(key);
        if (!set) { set = new Set(); this.listeners.set(key, set); }
        set.add(fn);
        return () => { set?.delete(fn); };
    }

    /**
     * Resolve with the params of the next matching event.
     * @param {string} method @param {{ sessionId?: string, timeoutMs?: number, filter?: (params: any) => boolean }} [opts]
     */
    once(method, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { off(); reject(new CdpError(`no ${method} event within ${timeoutMs} ms`, { method })); }, timeoutMs);
            const off = this.on(method, (params) => {
                if (opts.filter && !opts.filter(params)) return;
                clearTimeout(timer);
                off();
                resolve(params);
            }, opts.sessionId);
        });
    }

    /** A handle bound to one flat-mode target session. @param {string} sessionId */
    session(sessionId) {
        return new CdpSession(this, sessionId);
    }

    close() {
        try { this.ws.close(); } catch { /* ignore */ }
        this.#onClose("connection closed by client");
    }
}

export class CdpSession {
    /** @param {CdpConnection} conn @param {string} sessionId */
    constructor(conn, sessionId) {
        this.conn = conn;
        this.sessionId = sessionId;
    }

    /** @param {string} method @param {Record<string, unknown>} [params] @param {{ timeoutMs?: number }} [opts] */
    send(method, params = {}, opts = {}) {
        return this.conn.send(method, params, { ...opts, sessionId: this.sessionId });
    }

    /** @param {string} method @param {Listener} fn */
    on(method, fn) {
        return this.conn.on(method, fn, this.sessionId);
    }

    /** @param {string} method @param {{ timeoutMs?: number, filter?: (params: any) => boolean }} [opts] */
    once(method, opts = {}) {
        return this.conn.once(method, { ...opts, sessionId: this.sessionId });
    }

    /**
     * Evaluate an expression in the page and return its value (promises are
     * awaited). Throws a CdpError carrying the page exception text.
     * commandLineApi exposes the DevTools console helpers (getEventListeners)
     * to the expression.
     * @param {string} expression @param {{ timeoutMs?: number, commandLineApi?: boolean }} [opts]
     */
    async evaluate(expression, opts = {}) {
        const res = await this.send("Runtime.evaluate", {
            expression, awaitPromise: true, returnByValue: true, userGesture: false,
            includeCommandLineAPI: !!opts.commandLineApi,
        }, { timeoutMs: opts.timeoutMs });
        if (res.exceptionDetails) {
            const d = res.exceptionDetails;
            const text = d.exception?.description || d.exception?.value || d.text || "exception";
            throw new CdpError(`page threw: ${String(text).split("\n").slice(0, 3).join(" | ")}`, { method: "Runtime.evaluate" });
        }
        return res.result?.value;
    }

    /**
     * Poll `expression` until it returns a truthy value; return that value.
     * An exception in the page counts as "not yet". On timeout, throws with
     * the last value or exception seen.
     * @param {string} expression
     * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
     */
    async waitFor(expression, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 15_000;
        const intervalMs = opts.intervalMs ?? 150;
        const deadline = Date.now() + timeoutMs;
        /** @type {unknown} */
        let last;
        while (Date.now() < deadline) {
            try {
                last = await this.evaluate(expression, { timeoutMs: Math.max(1000, deadline - Date.now()) });
                if (last) return last;
            } catch (err) {
                last = /** @type {Error} */ (err).message;
            }
            await sleep(intervalMs);
        }
        throw new CdpError(`waitFor timed out after ${timeoutMs} ms: ${expression.slice(0, 120)} (last: ${String(JSON.stringify(last)).slice(0, 200)})`);
    }
}
