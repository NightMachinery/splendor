// @ts-check
/**
 * A small client for the Splendor Lobby Service (LS) and Game Service (GS)
 * REST APIs, as the web client uses them.
 *
 * Plain ES module, no dependencies: it uses the global fetch, so it runs in
 * Playwright specs, plain Node 24 (for example the Chrome CDP skill) and
 * browsers. Base URLs are the service roots, without a trailing slash, for
 * example { lsUrl: "http://127.0.0.1:4242", gsUrl: "http://127.0.0.1:4243" }
 * or, behind the site proxy, { lsUrl: origin + "/ls", gsUrl: origin + "/gs" }.
 * See stack.mjs to resolve them from E2E_INSTANCE / E2E_*_URL.
 *
 * Endpoints (contract from client/src/scripts and the server controllers):
 *   LS POST /api/local-auth {token, displayName} -> {token, username, displayName, preferredColour, role}
 *   LS POST /api/sessions?access_token= {creator, game: "splendor_<VERSION>", savegame} -> session id (text)
 *   LS PUT  /api/sessions/{id}/players/{user}?access_token=   join
 *   LS POST /api/sessions/{id}?access_token=                  launch (creator only)
 *   LS GET  /api/sessions/{id}                                session (400 when unknown)
 *   LS DELETE /api/sessions/{id}?access_token=                delete (creator, before launch)
 *   GS GET  /api/sessions/{id}                                game state (no hash: answers at once)
 *   GS PUT  /api/sessions/{id}/players/{user}/actions/{ACTION}?access_token= {json body}
 *   GS GET  /api/sessions/{id}/players/{user}/actions         action names (current player)
 *   both GET /api/online
 */

import { serviceName } from "./rules.mjs";

/** An HTTP answer the caller did not expect. */
export class ApiError extends Error {
    /** @param {string} message @param {{ status?: number, body?: string, method?: string, url?: string }} [info] */
    constructor(message, info = {}) {
        super(message);
        this.name = "ApiError";
        this.status = info.status;
        this.body = info.body;
        this.method = info.method;
        this.url = info.url;
    }
}

/**
 * @typedef {object} User
 * @property {string} username
 * @property {string} token      the LS access token (local-auth token)
 * @property {string} [displayName]
 * @property {string} [preferredColour]
 * @property {string} [role]
 */

/** A fresh random local-auth token (48 hex chars, like the web client's). */
export const randomToken = () => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} url */
const strip = (url) => String(url || "").trim().replace(/\/+$/, "");

export class SplendorApi {
    /**
     * @param {{ lsUrl: string, gsUrl: string, fetch?: typeof fetch, timeoutMs?: number }} opts
     */
    constructor({ lsUrl, gsUrl, fetch: fetchImpl, timeoutMs = 20_000 }) {
        if (!lsUrl || !gsUrl) throw new Error("SplendorApi needs both lsUrl and gsUrl");
        this.lsUrl = strip(lsUrl);
        this.gsUrl = strip(gsUrl);
        this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.timeoutMs = timeoutMs;
    }

    /**
     * One request. Returns { status, ok, text }; never throws on an HTTP
     * error status (callers decide), only on network failure or timeout.
     * @param {string} method @param {string} url
     * @param {{ json?: unknown, query?: Record<string, string>, timeoutMs?: number }} [opts]
     */
    async request(method, url, opts = {}) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(opts.query || {})) u.searchParams.set(k, v);
        /** @type {RequestInit} */
        const init = { method, signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs) };
        if (opts.json !== undefined) {
            init.headers = { "content-type": "application/json; charset=utf-8" };
            init.body = JSON.stringify(opts.json);
        }
        let resp;
        try {
            resp = await this.fetch(u, init);
        } catch (err) {
            throw new ApiError(`${method} ${redact(u)} failed: ${/** @type {Error} */ (err)?.message ?? err}`, { method, url: redact(u) });
        }
        const text = await resp.text();
        return { status: resp.status, ok: resp.ok, text };
    }

    /**
     * Like request, but throws ApiError unless the status is 2xx.
     * @param {string} method @param {string} url
     * @param {{ json?: unknown, query?: Record<string, string>, timeoutMs?: number }} [opts]
     */
    async expectOk(method, url, opts = {}) {
        const res = await this.request(method, url, opts);
        if (!res.ok) {
            const u = new URL(url);
            for (const [k, v] of Object.entries(opts.query || {})) u.searchParams.set(k, v);
            throw new ApiError(`${method} ${redact(u)} answered ${res.status}: ${res.text.slice(0, 500)}`,
                { status: res.status, body: res.text, method, url: redact(u) });
        }
        return res;
    }

    // ------------------------------------------------------------ health

    /** Whether the LS answers /api/online. */
    async lsOnline() {
        try { return (await this.request("GET", `${this.lsUrl}/api/online`, { timeoutMs: 5000 })).ok; } catch { return false; }
    }

    /** Whether the GS answers /api/online. */
    async gsOnline() {
        try { return (await this.request("GET", `${this.gsUrl}/api/online`, { timeoutMs: 5000 })).ok; } catch { return false; }
    }

    /** Wait until both services answer, or throw. @param {{ timeoutMs?: number }} [opts] */
    async waitUntilOnline(opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const deadline = Date.now() + timeoutMs;
        let ls = false;
        let gs = false;
        while (Date.now() < deadline) {
            [ls, gs] = await Promise.all([this.lsOnline(), this.gsOnline()]);
            if (ls && gs) return;
            await sleep(500);
        }
        throw new ApiError(`services not online after ${timeoutMs} ms: LS ${ls ? "up" : "down"} (${this.lsUrl}), GS ${gs ? "up" : "down"} (${this.gsUrl})`);
    }

    // ------------------------------------------------------------ Lobby Service

    /**
     * Log in (or create the account) the way the web client does: the LS maps
     * a token to one account, creating it on first use.
     * @param {{ displayName: string, token?: string }} opts
     * @returns {Promise<User>}
     */
    async localAuth({ displayName, token = randomToken() }) {
        const res = await this.expectOk("POST", `${this.lsUrl}/api/local-auth`, { json: { token, displayName } });
        const data = JSON.parse(res.text);
        if (typeof data.token !== "string" || typeof data.username !== "string") {
            throw new ApiError(`local-auth gave an unexpected reply: ${res.text.slice(0, 200)}`);
        }
        return { username: data.username, token: data.token, displayName: data.displayName, preferredColour: data.preferredColour, role: data.role };
    }

    /** A new local-auth user. @param {string} displayName */
    createUser(displayName) {
        return this.localAuth({ displayName });
    }

    /**
     * `count` new users named "<prefix> 1", "<prefix> 2", ... plus a unique
     * suffix, so repeated runs never collide.
     * @param {number} count @param {string} [prefix]
     */
    async createUsers(count, prefix = "E2E Player") {
        const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        const users = [];
        for (let i = 1; i <= count; i++) users.push(await this.createUser(`${prefix} ${i} ${run}`));
        return users;
    }

    /**
     * Create a session; returns its id as a string (ids are 63-bit numbers,
     * too big for a JS number).
     * @param {User} creator @param {string} version e.g. "BASE_ORIENT" @param {string} [savegame]
     */
    async createSession(creator, version, savegame = "") {
        const res = await this.expectOk("POST", `${this.lsUrl}/api/sessions`, {
            query: { access_token: creator.token },
            json: { creator: creator.username, game: serviceName(version), savegame },
        });
        const id = res.text.trim().replace(/^"|"$/g, "");
        if (!/^\d+$/.test(id)) throw new ApiError(`create session gave an unexpected reply: ${res.text.slice(0, 200)}`);
        return id;
    }

    /** @param {User} user @param {string} sessionId */
    async joinSession(user, sessionId) {
        await this.expectOk("PUT", `${this.lsUrl}/api/sessions/${sessionId}/players/${encodeURIComponent(user.username)}`, {
            query: { access_token: user.token },
        });
    }

    /** @param {User} creator @param {string} sessionId */
    async launchSession(creator, sessionId) {
        await this.expectOk("POST", `${this.lsUrl}/api/sessions/${sessionId}`, { query: { access_token: creator.token } });
    }

    /** @param {User} creator @param {string} sessionId */
    async deleteSession(creator, sessionId) {
        await this.expectOk("DELETE", `${this.lsUrl}/api/sessions/${sessionId}`, { query: { access_token: creator.token } });
    }

    /** The LS session, or null once the LS no longer knows it (a finished game is deleted). @param {string} sessionId */
    async getLobbySession(sessionId) {
        const res = await this.request("GET", `${this.lsUrl}/api/sessions/${sessionId}`);
        if (res.status === 400 || res.status === 404) return null;
        if (!res.ok) throw new ApiError(`GET LS session ${sessionId} answered ${res.status}: ${res.text.slice(0, 300)}`, { status: res.status, body: res.text });
        return JSON.parse(res.text);
    }

    /** All LS sessions, keyed by id. */
    async listLobbySessions() {
        const res = await this.expectOk("GET", `${this.lsUrl}/api/sessions`);
        return JSON.parse(res.text).sessions ?? {};
    }

    /**
     * Create, join and launch a game for `users` (the first one creates it
     * and moves first), then wait until the GS serves its state.
     * @param {{ users: User[], version: string, savegame?: string, timeoutMs?: number }} opts
     * @returns {Promise<string>} session id
     */
    async createGame({ users, version, savegame = "", timeoutMs = 30_000 }) {
        if (users.length < 2 || users.length > 4) throw new Error(`Splendor needs 2 to 4 players, got ${users.length}`);
        const [creator, ...others] = users;
        const sessionId = await this.createSession(creator, version, savegame);
        for (const u of others) await this.joinSession(u, sessionId);
        await this.launchSession(creator, sessionId);
        await this.waitForState(sessionId, { timeoutMs });
        return sessionId;
    }

    // ------------------------------------------------------------ Game Service

    /**
     * The raw state reply. Without `hash` the GS answers at once; with the
     * MD5 of the last body it long-polls and may answer 204 (no change).
     * @param {string} sessionId @param {{ hash?: string, timeoutMs?: number }} [opts]
     */
    async getStateText(sessionId, opts = {}) {
        const query = opts.hash ? { hash: opts.hash } : undefined;
        return this.request("GET", `${this.gsUrl}/api/sessions/${sessionId}`, { query, timeoutMs: opts.timeoutMs });
    }

    /** The current game state (parsed). Throws ApiError unless the GS answers 200. @param {string} sessionId */
    async getState(sessionId) {
        const res = await this.getStateText(sessionId);
        if (res.status !== 200) {
            throw new ApiError(`GET GS state ${sessionId} answered ${res.status}: ${res.text.slice(0, 300)}`, { status: res.status, body: res.text });
        }
        return JSON.parse(res.text);
    }

    /** Poll until the GS knows the session (right after launch). @param {string} sessionId @param {{ timeoutMs?: number }} [opts] */
    async waitForState(sessionId, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
            const res = await this.getStateText(sessionId);
            if (res.status === 200) return JSON.parse(res.text);
            last = res;
            await sleep(250);
        }
        throw new ApiError(`the GS never served session ${sessionId}: last answer ${last?.status} ${last?.text?.slice(0, 200)}`);
    }

    /**
     * Poll until the state differs from `before` (after a move made elsewhere,
     * for example through the board UI).
     * @param {string} sessionId @param {any} before @param {{ timeoutMs?: number }} [opts]
     */
    async waitForChange(sessionId, before, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 20_000;
        const old = JSON.stringify(before);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const res = await this.getStateText(sessionId);
            if (res.status === 200) {
                const now = JSON.parse(res.text);
                if (JSON.stringify(now) !== old) return now;
            }
            await sleep(150);
        }
        throw new ApiError(`the state of session ${sessionId} did not change within ${timeoutMs} ms`);
    }

    /**
     * Send one action. Returns { ok, status, text } without throwing on a
     * rejection: a 400 carries the rule violation in `text`.
     * @param {User} user @param {string} sessionId @param {string} action @param {unknown} [body]
     */
    putAction(user, sessionId, action, body = {}) {
        return this.request("PUT", `${this.gsUrl}/api/sessions/${sessionId}/players/${encodeURIComponent(user.username)}/actions/${action}`, {
            query: { access_token: user.token },
            json: body,
        });
    }

    /** Action names the current player may take (400 when it is not their turn). @param {string} username @param {string} sessionId */
    async getActionNames(username, sessionId) {
        const res = await this.expectOk("GET", `${this.gsUrl}/api/sessions/${sessionId}/players/${encodeURIComponent(username)}/actions`);
        return JSON.parse(res.text);
    }
}

/** Hide access tokens in URLs that end up in error messages. @param {URL} url */
const redact = (url) => {
    const u = new URL(url);
    if (u.searchParams.has("access_token")) u.searchParams.set("access_token", "***");
    return u.toString();
};

/**
 * Convenience: an API client for a resolved stack (see stack.mjs).
 * @param {{ lsUrl: string, gsUrl: string }} stack @param {{ timeoutMs?: number }} [opts]
 */
export const apiFor = (stack, opts = {}) => new SplendorApi({ lsUrl: stack.lsUrl, gsUrl: stack.gsUrl, ...opts });
