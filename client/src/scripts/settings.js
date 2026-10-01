// Define settings to be used, that are shared across the frontend

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

const getRoomMigrateToken = () => {
    const params = new URL(document.location.toString()).searchParams;
    return params.get("migrate");
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
 * fetch() that turns a network failure into a TransientAuthError.
 */
const fetchOrTransient = async (url, init) => {
    try {
        return await fetch(url, init);
    } catch(err) {
        throw new TransientAuthError(`Could not reach the lobby service: ${err && err.message ? err.message : err}`);
    }
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
     * Get the access token stored in local storage
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
            window.location.href = "/login/";
        }
    },

    clearLocalIdentity: () => {
        localStorage.removeItem("username");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("accessToken");
        localStorage.removeItem("displayName");
    },

    hasLocalIdentity: () => !!localStorage.getItem("displayName"),

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
    verifyCredentials: async (options = {}) => {
        const { allowCreate = false, displayName: requestedDisplayName = null } = options;
        const roomToken = getRoomMigrateToken();
        const roomId = getRoomId();
        if(roomToken && roomId) {
            const resp = await fetchOrTransient(`${SETTINGS.getLS_API()}/api/sessions/${roomId}/migrate/${roomToken}`);
            if(resp.ok) {
                let data = null;
                try {
                    data = await resp.json();
                } catch(err) {
                    throw new TransientAuthError("Lobby service sent an unreadable migrate reply.", resp.status);
                }
                sessionStorage.setItem(`roomUser:${roomId}:${roomToken}`, data.name);
                return data;
            }
            if(resp.status >= 500 || resp.status === 429) {
                throw new TransientAuthError(`Lobby service answered ${resp.status} while checking the migrate link.`, resp.status);
            }
            // an invalid or expired migrate link falls back to the local identity
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

        const resp = await fetchOrTransient(`${SETTINGS.getLS_API()}/api/local-auth`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, displayName })
        });
        const bodyText = await resp.text().catch(() => "");
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
 */
export const GAME_VERSION_TO_BOARD = {
    "BASE_ORIENT": "gameboard",
    "BASE_ORIENT_CITIES": "gameboard-cities",
    "BASE_ORIENT_TRADE_ROUTES": "gameboard-tradingposts"
};
