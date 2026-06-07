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
     * Verify that the user is logged in.
     * Will boot user to login screen if not.
     */
    verifyCredentials: async (options = {}) => {
        const { allowCreate = false } = options;
        const roomToken = getRoomMigrateToken();
        const roomId = getRoomId();
        if(roomToken && roomId) {
            const resp = await fetch(`${SETTINGS.getLS_API()}/api/sessions/${roomId}/migrate/${roomToken}`);
            if(resp.ok) {
                const data = await resp.json();
                sessionStorage.setItem(`roomUser:${roomId}:${roomToken}`, data.name);
                return data;
            }
        }

        let displayName = localStorage.getItem("displayName");
        if(!displayName) {
            if(allowCreate) {
                displayName = "Player";
                localStorage.setItem("displayName", displayName);
            } else {
                SETTINGS.goToLogin();
                throw new Error("Display name required.");
            }
        }

        let token = localStorage.getItem("accessToken");
        if(!token) {
            const bytes = new Uint8Array(24);
            window.crypto.getRandomValues(bytes);
            token = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
            SETTINGS.setAccessToken(token);
        }

        const resp = await fetch(`${SETTINGS.getLS_API()}/api/local-auth`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, displayName })
        });
        if(!resp.ok) {
            SETTINGS.clearLocalIdentity();
            SETTINGS.goToLogin();
            throw new Error(await resp.text());
        }
        const data = await resp.json();
        SETTINGS.setAccessToken(data.token);
        SETTINGS.setUsername(data.username);
        localStorage.setItem("displayName", data.displayName);
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
