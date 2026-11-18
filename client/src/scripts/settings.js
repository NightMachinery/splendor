// Define settings to be used, that are shared across the frontend

import { md5Hex } from "./local-md5.js";
import { readLobbyInvite, withLobbyInvite } from "./lobby-invite.js";

/**
 * Check if the endpoint is alive.
 * 
 * @param {string} endpoint 
 * @returns true if valid endpoint
 */
const checkEndpoint = async (endpoint) => {
    const resp = await fetch(`${endpoint}/api/online`);
    return resp.ok;
};

/**
 * Internal settings that shouldn't be exposed.
 */
const INTERNAL_SETTINGS = {
    /**
     * Location for access to the game service.
     * Null if custom endpoint not set.
     */
    GS_API: "",

    /**
     * Location for access to the Lobby Service.
     * Null if custom endpoint not set.
     */
    LS_API: "",
};

/**
 * Define the settings.
 */

/**
 * Migrate token that the Lobby Service rejected on this page (invalid or
 * expired link). From then on the page uses the local identity for both the
 * username and the access token, instead of mixing the local username with
 * the dead room token (which the GS answers with a 401).
 */
let rejectedMigrateToken = null;

const getRoomMigrateToken = () => {
    const params = new URL(document.location.toString()).searchParams;
    const token = params.get("migrate");
    return token && token === rejectedMigrateToken ? null : token;
};

/**
 * Remember that the LS rejected this page's migrate token, and drop the
 * parameter from the address bar so that a reload or a copied URL does not
 * try the dead link again.
 */
const rejectMigrateToken = (token) => {
    rejectedMigrateToken = token;
    try {
        const url = new URL(document.location.toString());
        url.searchParams.delete("migrate");
        window.history.replaceState(window.history.state, "", url.toString());
    } catch(err) {
        // no history API (tests) or a sandboxed frame: the flag is enough
    }
};

const getRoomId = () => {
    const params = new URL(document.location.toString()).searchParams;
    return params.get("sessionId");
};

const isLoginPage = () => window.location.pathname.replace(/\/+$/, "") === "/login";

/**
 * The Lobby Service definitively rejected the stored identity (or there is
 * none). The local identity has been cleared and the login page requested.
 */
export class AuthRejectedError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = "AuthRejectedError";
        this.authRejected = true;
        this.status = status;
    }
}

/**
 * Identity could not be checked right now (network error, 5xx, 429, or an
 * unreadable reply). Nothing was cleared; retry later.
 */
export class TransientAuthError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = "TransientAuthError";
        this.transient = true;
        this.status = status;
    }
}

/**
 * Whether a failed /api/local-auth reply means "this token is not valid"
 * rather than "the server is having trouble". Only 401 and 403 qualify, plus
 * any 4xx whose JSON body is {"error": "unknown_token"} or
 * {"error": "invalid_token"} (a contract the LS may adopt for unknown tokens).
 *
 * @param {number} status
 * @param {string} bodyText
 * @returns {boolean}
 */
export const isDefinitiveAuthRejection = (status, bodyText = "") => {
    if(status === 401 || status === 403) return true;
    if(status < 400 || status >= 500) return false;
    try {
        const body = JSON.parse(bodyText);
        return !!body && (body.error === "unknown_token" || body.error === "invalid_token");
    } catch(err) {
        return false;
    }
};

/**
 * How long an identity request (local-auth or a migrate check) may take,
 * headers and body together. verifyCredentials() caches its pending promise
 * and every poll cycle and action awaits it, so a request that never
 * finishes (a dead socket after a network switch, a stalled LS) would
 * otherwise freeze the page with no "Reconnecting..." indicator.
 */
export const IDENTITY_REQUEST_TIMEOUT_MS = 15000;

/**
 * fetch() and read the body as text, with a timeout. Turns a network
 * failure or a timeout into a TransientAuthError.
 *
 * @returns {Promise<{ok: boolean, status: number, text: string}>}
 */
const fetchTextOrTransient = async (url, init = {}) => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), IDENTITY_REQUEST_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { ...init, signal: controller.signal });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, text };
    } catch(err) {
        if(controller.signal.aborted) {
            throw new TransientAuthError(`The lobby service did not answer within ${IDENTITY_REQUEST_TIMEOUT_MS / 1000} s.`);
        }
        throw new TransientAuthError(`Could not reach the lobby service: ${err && err.message ? err.message : err}`);
    } finally {
        clearTimeout(abortTimer);
    }
};

/** Cached verifyCredentials() promise for this page load (see SETTINGS.verifyCredentials). */
let credentialsPromise = null;

/**
 * Verify that the user is logged in, creating the local account on the
 * Lobby Service (LS) if this browser has never registered its token.
 *
 * Identity safety: the stored identity is cleared only when the LS
 * definitively rejects it (see isDefinitiveAuthRejection). Network
 * errors, 5xx replies (for example Caddy's 502 during a redeploy), 429
 * and unreadable replies throw a TransientAuthError and keep every stored
 * key, so a server outage can never replace a user's account.
 *
 * @param {{allowCreate?: boolean, displayName?: string}} options
 *   allowCreate: login page only; register with `displayName` (or
 *   "Player") when no display name is stored yet. displayName is stored
 *   only after the LS accepted it.
 * @returns {Promise<object>} the LS local-auth reply, or the migrate reply
 * @throws {AuthRejectedError} identity rejected or missing (login page shown)
 * @throws {TransientAuthError} try again later; nothing was cleared
 */
const checkCredentialsNow = async (options = {}) => {
    const { allowCreate = false, displayName: requestedDisplayName = null } = options;
    const roomToken = getRoomMigrateToken();
    const roomId = getRoomId();
    if(roomToken && roomId) {
        const resp = await fetchTextOrTransient(`${SETTINGS.getLS_API()}/api/sessions/${roomId}/migrate/${roomToken}`);
        if(resp.ok) {
            let data = null;
            try {
                data = JSON.parse(resp.text);
            } catch(err) {
                data = null;
            }
            if(!data || typeof data.name !== "string") {
                throw new TransientAuthError("Lobby service sent an unreadable migrate reply.", resp.status);
            }
            sessionStorage.setItem(`roomUser:${roomId}:${roomToken}`, data.name);
            return data;
        }
        if(resp.status >= 500 || resp.status === 429) {
            throw new TransientAuthError(`Lobby service answered ${resp.status} while checking the migrate link.`, resp.status);
        }
        // An invalid or expired migrate link (the LS answers 400): use the
        // local identity for the whole page, token and username alike.
        rejectMigrateToken(roomToken);
    }

    let displayName = requestedDisplayName || localStorage.getItem("displayName");
    if(!displayName) {
        if(allowCreate) {
            displayName = "Player";
        } else {
            SETTINGS.goToLogin();
            throw new AuthRejectedError("Display name required.");
        }
    }

    let token = localStorage.getItem("accessToken");
    if(!token) {
        // Stored before the request so that a reply lost in transit is
        // retried with the same token and maps to the same account.
        const bytes = new Uint8Array(24);
        window.crypto.getRandomValues(bytes);
        token = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
        SETTINGS.setAccessToken(token);
    }

    const resp = await fetchTextOrTransient(`${SETTINGS.getLS_API()}/api/local-auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, displayName })
    });
    const bodyText = resp.text;
    if(!resp.ok) {
        if(isDefinitiveAuthRejection(resp.status, bodyText)) {
            SETTINGS.clearLocalIdentity();
            SETTINGS.goToLogin();
            throw new AuthRejectedError(bodyText || `Lobby service rejected the stored identity (${resp.status}).`, resp.status);
        }
        throw new TransientAuthError(`Lobby service answered ${resp.status} while checking your identity.`, resp.status);
    }

    let data = null;
    try {
        data = JSON.parse(bodyText);
    } catch(err) {
        data = null;
    }
    if(!data || typeof data.token !== "string" || typeof data.username !== "string") {
        // e.g. an HTML error page served with 200 by a proxy
        throw new TransientAuthError("Lobby service sent an unreadable identity reply.", resp.status);
    }
    SETTINGS.setAccessToken(data.token);
    SETTINGS.setUsername(data.username);
    localStorage.setItem("displayName", data.displayName || displayName);
    return data;
};

export const SETTINGS = {

    /**
     * Set the GS API Endpoint origin.
     * 
     * @param {string} gs 
     */
    setGS_API: (gs) => {
        try {
            checkEndpoint(gs).then(() => INTERNAL_SETTINGS.GS_API = gs);
        } catch(err) {
            window.alert("Could not set GS Endpoint: " + err);
        }
    },

    /**
     * Location for access to the Game Service.
     * 
     * @returns location origin of GS
     */
    getGS_API: () => {
        // if custom set, return that
        if(INTERNAL_SETTINGS.GS_API !== "") {
            return INTERNAL_SETTINGS.GS_API;
        }

        return `${window.location.origin}/gs`;
    },

    /**
     * Set the LS API Endpoint origin.
     * 
     * @param {string} ls 
     */
    setLS_API: (ls) => {
        try {
            checkEndpoint(ls).then(() => INTERNAL_SETTINGS.LS_API = ls);
        } catch(err) {
            window.alert("Could not set LS Endpoint: " + err);
        }
    },

    /**
     * Location for access to the Lobby Service.
     * 
     * @returns location origin of LS
     */
    getLS_API: () => {
        // if custom set, return that
        if(INTERNAL_SETTINGS.LS_API !== "") {
            return INTERNAL_SETTINGS.LS_API;
        }

        return `${window.location.origin}/ls`;
    },

    /**
     * The access token: the migrate token while the page URL carries a
     * migrate link the LS has not rejected, otherwise the one in local storage.
     * @returns string | null
     */
    getAccessToken: () => {
        return getRoomMigrateToken() || localStorage.getItem("accessToken");
    },

    /**
     * Store the access token in local storage
     * @param {string} token 
     */
    setAccessToken: (token) => {
        localStorage.setItem("accessToken", token);
    },

    /**
     * Get the refresh token stored in local storage
     * @returns string | null
     */
    getRefreshToken: () => {
        return localStorage.getItem("refreshToken");
    },

    /**
     * Store the refresh token in local storage
     * @param {string} token 
     */
    setRefreshToken: (token) => {
        localStorage.setItem("refreshToken", token);
    },

    /**
     * Get the username stored in local storage
     * @returns string | null
     */
    getUsername: () => {
        const roomToken = getRoomMigrateToken();
        const roomId = getRoomId();
        if(roomToken && roomId) {
            return sessionStorage.getItem(`roomUser:${roomId}:${roomToken}`) || localStorage.getItem("username");
        }
        return localStorage.getItem("username");
    },
    
    /**
     * Store the username in local storage
     * @param {string} setUsername 
     */
    setUsername: (username) => {
        localStorage.setItem("username", username);
    },

    /**
     * Get the username of the currently stored token.
     * @returns string | null
     */
    fetchUsername: async () => {
        // build url
        const url = new URL(`${SETTINGS.getLS_API()}/oauth/username`);
        url.search = new URLSearchParams({ "access_token": SETTINGS.getAccessToken() }).toString();

        const resp = await fetch(url, { method: "GET" });

        if(!resp.ok) {
            return null;
        }

        const rTest = await resp.text();

        return rTest;
    },

    /**
     * Attempt to refresh access token with refresh token.
     * @returns string | null - returns access token
     */
    refreshAccessToken: async () => {
        return SETTINGS.getAccessToken();
    },

    /**
     * Force client to go to login screen.
     */
    goToLogin: () => {
        if(!isLoginPage()) {
            const inLobby = window.location.pathname.replace(/\/+$/, "") === "/lobby";
            window.location.href = withLobbyInvite("/login/", inLobby ? readLobbyInvite() : null);
        }
    },

    clearLocalIdentity: () => {
        credentialsPromise = null;
        localStorage.removeItem("username");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("accessToken");
        localStorage.removeItem("displayName");
    },

    hasLocalIdentity: () => !!localStorage.getItem("displayName"),

    /**
     * Whether the LS rejected the migrate link this page was opened with, so
     * that the page now runs as the local identity.
     * @returns {boolean}
     */
    migrateLinkRejected: () => rejectedMigrateToken !== null,

    /**
     * Verify that the user is logged in (see checkCredentialsNow).
     *
     * The check runs once per page load: the first successful result is
     * cached and every later call returns it without a request. A failed
     * check is not cached, so the next call retries. Call
     * invalidateCredentials() after an auth failure (401) to force a fresh
     * check. allowCreate or force always runs a fresh check.
     *
     * @param {{allowCreate?: boolean, displayName?: string, force?: boolean}} options
     * @returns {Promise<object>}
     */
    verifyCredentials: (options = {}) => {
        const fresh = !!(options.force || options.allowCreate);
        if(!fresh && credentialsPromise) {
            return credentialsPromise;
        }
        const attempt = checkCredentialsNow(options);
        credentialsPromise = attempt;
        attempt.catch(() => {
            if(credentialsPromise === attempt) credentialsPromise = null;
        });
        return attempt;
    },

    /**
     * Forget the cached verifyCredentials() result so that the next call asks
     * the Lobby Service again. Use after a request failed with 401.
     */
    invalidateCredentials: () => {
        credentialsPromise = null;
    },

    /**
     * Removes all saved tokens and credentials.
     */
    logout: () => {
        SETTINGS.clearLocalIdentity();
    },
};

/**
 * Maps the game version enum from the backend to the corresponding board.
 * The keys are also the versions whose saved games the lobby lists.
 */
export const GAME_VERSION_TO_BOARD = {
    "BASE_ORIENT": "gameboard",
    // Cities without nobles: the official module rule and the default
    "BASE_ORIENT_CITIES": "gameboard-cities",
    // Cities played with nobles as well
    "BASE_ORIENT_CITIES_NOBLES": "gameboard-cities",
    "BASE_ORIENT_TRADE_ROUTES": "gameboard-tradingposts"
};

/**
 * The client has no board for this game version (for example a server that
 * is newer than the cached client).
 */
export class UnknownGameVersionError extends Error {
    constructor(version) {
        super(`This client cannot show the game version "${version}". Reload the page to get the latest client.`);
        this.name = "UnknownGameVersionError";
        this.version = version;
    }
}

/**
 * Path of the board page for a game version, e.g. "/gameboard-cities/".
 * Accepts the bare enum name or the LS game-service name ("splendor_<VERSION>").
 *
 * @param {string} version
 * @returns {string}
 * @throws {UnknownGameVersionError} instead of producing "/undefined/"
 */
export const boardPathForVersion = (version) => {
    const key = String(version || "").replace(/^splendor_/, "");
    const board = Object.prototype.hasOwnProperty.call(GAME_VERSION_TO_BOARD, key) ? GAME_VERSION_TO_BOARD[key] : null;
    if(!board) {
        throw new UnknownGameVersionError(key || String(version));
    }
    return `/${board}/`;
};

/* ------------------------------------------------------------------------ *
 * Long polling
 *
 * Both servers hold a GET for up to 30 s when its `hash` query parameter is
 * the MD5 of the JSON they would send (see local-md5.js), and answer at once
 * with the new JSON otherwise. On timeout the Game Service (GS) answers 204
 * and the Lobby Service (LS) 408. createLongPoll() runs one such loop with:
 * - immediate re-poll after a 204/408 or after a rendered update, but never
 *   more often than once per MIN_CYCLE_MS, so a server that answers at once
 *   cannot turn the loop into a hot loop;
 * - exponential backoff with jitter (capped at MAX_BACKOFF_MS) on network
 *   errors, 5xx, non-JSON replies, client errors and render errors;
 * - the stored hash updated only after onUpdate() rendered successfully, so a
 *   failed render is retried with the same state;
 * - optionally (pauseWhenHidden) no new request while document.hidden; every
 *   loop sends an immediate fresh request on visibilitychange (visible) and
 *   online;
 * - a shared "Reconnecting..." indicator instead of error toasts for
 *   connection problems;
 * - optionally (hold: false) plain periodic GETs instead of held requests,
 *   used for the LS for now (see LS_HOLDS_REQUESTS).
 * ------------------------------------------------------------------------ */

/**
 * Whether the client lets the Lobby Service hold its long-polls.
 *
 * false for now: the LS's long-poll library (asyncrestlib 1.5.1, see
 * SessionController.getHashBasedUpdate) starts a thread per held request
 * that waits on a latch with no timeout. A 408 timeout or a client abort
 * does not end it; only a change of the watched content does. An idle
 * lobby tab or board leaked about 120 such threads an hour (about 280 KB
 * each), and those of a launched session that is abandoned are never
 * freed. The same library also loses a wakeup when the content changes
 * between its hash check and the start of the wait, delaying that update
 * by the full 30 s.
 *
 * So the LS loops send a hash that never matches (the LS answers at once,
 * no thread is started) every few seconds and compare the MD5 locally.
 * Set this to true once the LS ends every held wait with its request (a
 * timed wait, or completing the DeferredResult from touch()) and takes its
 * latch before the hash comparison. Then the lobby and the board's LS
 * session loop long-poll like the GS loop. See
 * docs/client-architecture.md, "Why the LS loops do not hold requests".
 */
export const LS_HOLDS_REQUESTS = false;

const MIN_CYCLE_MS = 750;
const MAX_BACKOFF_MS = 30000;
const FIRST_BACKOFF_MS = 1000;
// longer than the servers' 30 s hold (the GS waits up to 33 s internally)
const REQUEST_TIMEOUT_MS = 50000;

/**
 * Exponential backoff with "equal jitter": a delay in [d/2, d] where
 * d = min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2^(streak-1)).
 *
 * @param {number} streak consecutive failures, >= 1
 * @returns {number} milliseconds
 */
export const backoffDelay = (streak) => {
    const ceiling = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, streak - 1));
    return Math.round(ceiling / 2 + Math.random() * ceiling / 2);
};

/**
 * Tests (and anyone debugging two players in two tabs) can keep the loops
 * that pause in hidden tabs polling with
 * localStorage.setItem("splendorPollWhenHidden", "1").
 */
const pollWhenHidden = () => {
    try {
        return localStorage.getItem("splendorPollWhenHidden") === "1";
    } catch(err) {
        return false;
    }
};

const pageHidden = () => typeof document !== "undefined" && document.hidden && !pollWhenHidden();

// names of the polls that currently cannot reach their server
const reconnectingPolls = new Set();

/**
 * Show or hide the shared "Reconnecting..." indicator. It is created from JS
 * with minimal inline styling (the UX pass may restyle #splendor-connection-indicator).
 * document.body.dataset.splendorConnection mirrors it: "ok" or "reconnecting".
 */
const renderConnectionIndicator = () => {
    if(typeof document === "undefined" || !document.body) return;
    let elm = document.getElementById("splendor-connection-indicator");
    if(reconnectingPolls.size === 0) {
        if(elm) elm.style.display = "none";
        document.body.dataset.splendorConnection = "ok";
        return;
    }
    if(!elm) {
        elm = document.createElement("div");
        elm.id = "splendor-connection-indicator";
        elm.className = "connection-indicator";
        elm.setAttribute("role", "status");
        elm.setAttribute("aria-live", "polite");
        elm.textContent = "Reconnecting...";
        elm.style.cssText = [
            "position:fixed", "right:8px", "bottom:max(8px, env(safe-area-inset-bottom))", "z-index:2000",
            "padding:4px 10px", "border-radius:999px", "background:rgba(0,0,0,0.72)", "color:#fff",
            "font:13px/1.4 system-ui, sans-serif", "pointer-events:none",
        ].join(";");
        document.body.appendChild(elm);
    }
    elm.style.display = "";
    document.body.dataset.splendorConnection = "reconnecting";
};

const setReconnecting = (name, on) => {
    const had = reconnectingPolls.has(name);
    // render at least once, so data-splendor-connection is set after the first outcome
    const rendered = typeof document !== "undefined" && document.body && document.body.dataset.splendorConnection;
    if(on === had && rendered) return;
    if(on) reconnectingPolls.add(name); else reconnectingPolls.delete(name);
    renderConnectionIndicator();
};

const activePolls = new Set();
let pollListenersInstalled = false;

const installPollListeners = () => {
    if(pollListenersInstalled || typeof document === "undefined") return;
    pollListenersInstalled = true;
    document.addEventListener("visibilitychange", () => {
        if(!document.hidden) activePolls.forEach(p => p.wake({ restart: true }));
    });
    window.addEventListener("online", () => activePolls.forEach(p => p.wake({ restart: true })));
};

/**
 * Error describing a failed poll request.
 */
export class PollError extends Error {
    constructor(message, kind, status = 0) {
        super(message);
        this.name = "PollError";
        this.kind = kind;
        this.status = status;
    }
}

/**
 * Create a long-poll loop. Nothing happens until start().
 *
 * @param {object} options
 * @param {string} options.name unique name, used in logs and for the indicator
 * @param {(hash: string) => (string|URL)} options.url request URL for the hash to send
 * @param {(data: any, text: string, hash: string) => (void|Promise<void>)} options.onUpdate
 *   render a new state; throwing keeps the previous hash and backs off
 * @param {() => Promise<void>} [options.beforeRequest] runs before every request,
 *   e.g. () => SETTINGS.verifyCredentials() (cached, so free after the first call).
 *   An AuthRejectedError stops the loop; other errors back off.
 * @param {(status: number, text: string) => boolean} [options.onGone] called on
 *   400/404/410; return true to stop polling for good (for example a deleted session)
 * @param {(err: PollError, info: {kind: string, status: number, streak: number}) => void} [options.onError]
 *   told about every failed cycle. kind is one of "network", "server",
 *   "non-json", "auth", "client" or "render".
 * @param {boolean} [options.indicator=true] whether connection failures of
 *   this loop show the "Reconnecting..." indicator
 * @param {boolean} [options.hold=true] let the server hold requests (send the
 *   stored hash). false: send "-", which never matches, so the server answers
 *   at once; poll every intervalMs and render only when the MD5 changed.
 * @param {number} [options.intervalMs=5000] with hold: false, the time from
 *   the start of one request to the start of the next
 * @param {boolean} [options.pauseWhenHidden=false] send no new request while
 *   the tab is hidden (resumed on visibilitychange). Leave it off for state a
 *   background tab must still notice, such as the board's game state, so that
 *   a waiting player's tab learns that it is their turn.
 */
export const createLongPoll = (options) => {
    const {
        name, url, onUpdate, beforeRequest = null, onGone = null, onError = null, indicator = true,
        pauseWhenHidden = false, hold = true, intervalMs = 5000,
    } = options;
    let hash = "-";
    let started = false;
    let stopped = false;
    let running = false;
    let timer = null;
    let wakeRequested = false;
    let request = null; // { controller, woken }
    let errorStreak = 0;
    let sameHashStreak = 0;

    const minCycle = (startedAt) => Math.max(0, MIN_CYCLE_MS - (Date.now() - startedAt));
    // delay after a successful cycle: at once for held requests, else the interval
    const nextCycle = (startedAt) => (hold
        ? minCycle(startedAt)
        : Math.max(minCycle(startedAt), intervalMs - (Date.now() - startedAt)));

    const recovered = () => {
        errorStreak = 0;
        if(indicator) setReconnecting(name, false);
    };

    const failed = (kind, err, status = 0) => {
        errorStreak++;
        const connectionProblem = kind === "network" || kind === "server" || kind === "non-json" || kind === "auth";
        // A client or render failure still means the server answered, so it
        // clears the indicator (and sets data-splendor-connection on a first outcome).
        if(indicator) setReconnecting(name, connectionProblem);
        if(errorStreak === 1 || !connectionProblem) {
            console.warn(`[poll:${name}] ${kind} problem (retrying with backoff): ${err && err.message ? err.message : err}`);
        }
        if(onError) {
            try {
                onError(err instanceof PollError ? err : new PollError(String(err && err.message ? err.message : err), kind, status),
                        { kind, status, streak: errorStreak });
            } catch(cbErr) {
                console.error(cbErr);
            }
        }
        return backoffDelay(errorStreak);
    };

    /** One request/response cycle. Returns the delay before the next one, or null to stop. */
    const runOnce = async () => {
        const startedAt = Date.now();
        if(beforeRequest) {
            try {
                await beforeRequest();
            } catch(err) {
                if(err && err.authRejected) return null; // the login page is being shown
                return failed(err && err.transient ? "auth" : "client", err, err && err.status);
            }
        }

        const sentHash = hold ? hash : "-";
        const req = { controller: new AbortController(), woken: false };
        request = req;
        const abortTimer = setTimeout(() => req.controller.abort(), REQUEST_TIMEOUT_MS);
        let resp;
        let text;
        try {
            resp = await fetch(url(sentHash), { signal: req.controller.signal, cache: "no-store" });
            text = await resp.text();
        } catch(err) {
            if(req.woken) return 0; // aborted on purpose by wake({restart: true})
            return failed("network", err);
        } finally {
            clearTimeout(abortTimer);
            if(request === req) request = null;
        }

        if(resp.status === 204 || resp.status === 408) {
            // the server held the request and nothing changed
            recovered();
            sameHashStreak = 0;
            return nextCycle(startedAt);
        }
        if(resp.status === 401 || resp.status === 403) {
            SETTINGS.invalidateCredentials();
            return failed("auth", new PollError(text || `HTTP ${resp.status}`, "auth", resp.status), resp.status);
        }
        if(resp.status === 400 || resp.status === 404 || resp.status === 410) {
            if(onGone && onGone(resp.status, text)) {
                recovered();
                return null;
            }
            return failed("client", new PollError(text || `HTTP ${resp.status}`, "client", resp.status), resp.status);
        }
        if(!resp.ok) {
            return failed("server", new PollError(`HTTP ${resp.status}`, "server", resp.status), resp.status);
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch(err) {
            return failed("non-json", new PollError("The server sent a reply that is not JSON.", "non-json", resp.status), resp.status);
        }
        recovered();

        const newHash = md5Hex(text);
        if(!hold && newHash === hash) {
            // periodic poll: nothing changed since the last render
            return nextCycle(startedAt);
        }
        if(newHash === sentHash) {
            // The server should have held this request. Do not spin.
            sameHashStreak++;
            return Math.max(minCycle(startedAt), backoffDelay(sameHashStreak));
        }
        sameHashStreak = 0;

        try {
            await onUpdate(data, text, newHash);
        } catch(err) {
            console.error(`[poll:${name}] render failed`, err);
            return failed("render", err);
        }
        hash = newHash; // only after a successful render
        return nextCycle(startedAt);
    };

    const schedule = (delay) => {
        if(stopped || delay === null) {
            if(delay === null) poll.stop();
            return;
        }
        if(wakeRequested) {
            wakeRequested = false;
            delay = 0;
        }
        timer = setTimeout(cycle, delay);
    };

    const cycle = async () => {
        timer = null;
        if(stopped) return;
        if(pauseWhenHidden && pageHidden()) return; // resumed by wake() on visibilitychange
        running = true;
        let delay;
        try {
            delay = await runOnce();
        } catch(err) {
            // last-resort guard: nothing may stop the loop by accident
            console.error(`[poll:${name}] unexpected error`, err);
            errorStreak++;
            delay = backoffDelay(errorStreak);
        } finally {
            running = false;
        }
        schedule(delay);
    };

    const poll = {
        name,
        /** Start polling (idempotent). */
        start: () => {
            if(started || stopped) return;
            started = true;
            activePolls.add(poll);
            installPollListeners();
            cycle();
        },
        /** Stop for good. */
        stop: () => {
            stopped = true;
            activePolls.delete(poll);
            if(timer) clearTimeout(timer);
            timer = null;
            if(request) {
                request.woken = true;
                request.controller.abort();
            }
            if(indicator) setReconnecting(name, false);
        },
        /**
         * Poll now instead of waiting out a backoff or a hidden-tab pause.
         * restart: also abort a request in flight (it may sit on a dead
         * connection after sleep or a network change) and send a new one.
         */
        wake: ({ restart = false } = {}) => {
            if(!started || stopped) return;
            if(running) {
                if(restart && request) {
                    request.woken = true;
                    request.controller.abort();
                } else {
                    wakeRequested = true;
                }
                return;
            }
            if(timer) clearTimeout(timer);
            timer = null;
            cycle();
        },
        /** MD5 of the last state passed to a successful onUpdate(), or "-". */
        getHash: () => hash,
        /** Seed the hash, e.g. from a state fetched before start(). */
        setHash: (newHash) => {
            hash = newHash || "-";
        },
    };
    return poll;
};

/**
 * fetch() with a timeout, for one-shot requests that must not hang forever.
 *
 * @param {string|URL} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
export const fetchWithTimeout = async (url, init = {}, timeoutMs = 10000) => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(abortTimer);
    }
};

// Another tab logging in or out changes the stored identity: check it again.
if(typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (e) => {
        if(e.key === null || ["accessToken", "username", "displayName"].includes(e.key)) {
            credentialsPromise = null;
        }
    });
}
