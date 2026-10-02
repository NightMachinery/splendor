// A minimal browser for unit tests of client/src/scripts/settings.js under
// node: location, history, storage, document.body.dataset and a scripted
// fetch. Install it before importing settings.js, because the module reads
// these globals at call time and registers its listeners on first use.

const makeStorage = () => {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
        clear: () => map.clear(),
        keys: () => [...map.keys()],
    };
};

const makeEventTarget = () => {
    const listeners = new Map();
    return {
        addEventListener: (type, fn) => {
            if(!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener: (type, fn) => {
            listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn));
        },
        dispatchEvent: (event) => {
            (listeners.get(event.type) || []).forEach(fn => fn(event));
            return true;
        },
    };
};

/**
 * A scripted fetch. Each call is recorded in `calls` and answered by
 * `handler(call)`, which returns a reply description or a Promise of one:
 * - {status, body}: a Response with that status and text body;
 * - "hang": never answers, rejects with an AbortError when aborted;
 * - "hang-body": headers arrive (status 200), the body never does;
 * - "network": rejects with a TypeError, like a refused connection.
 */
export const makeFetch = () => {
    const state = { calls: [], handler: () => ({ status: 500, body: "no handler" }) };
    const abortError = () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        return err;
    };
    const untilAborted = (signal) => new Promise((resolve, reject) => {
        if(!signal) return;
        if(signal.aborted) reject(abortError());
        signal.addEventListener("abort", () => reject(abortError()));
    });
    const fetch = async (url, init = {}) => {
        const call = { url: String(url), method: init.method || "GET", body: init.body, signal: init.signal, answered: false };
        state.calls.push(call);
        const reply = await state.handler(call);
        if(reply === "hang") {
            return untilAborted(init.signal);
        }
        if(reply === "network") {
            throw new TypeError("Failed to fetch");
        }
        if(reply === "hang-body") {
            return { ok: true, status: 200, text: () => untilAborted(init.signal), json: () => untilAborted(init.signal) };
        }
        call.answered = true;
        const status = reply.status;
        const body = reply.body === undefined ? "" : (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
        return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
    };
    state.fetch = fetch;
    return state;
};

/**
 * Install the fake browser globals. Returns handles to drive it.
 */
export const installFakeBrowser = (startUrl = "http://splendor.test/lobby/") => {
    let href = startUrl;
    const location = {
        get href() { return href; },
        set href(value) { href = new URL(value, href).toString(); },
        get origin() { return new URL(href).origin; },
        get pathname() { return new URL(href).pathname; },
        get search() { return new URL(href).search; },
        toString() { return href; },
    };
    const windowTarget = makeEventTarget();
    const documentTarget = makeEventTarget();
    const replaced = [];
    const body = {
        dataset: {},
        children: [],
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    };
    const document = {
        ...documentTarget,
        location,
        hidden: false,
        body,
        getElementById: (id) => body.children.find(c => c.id === id) || null,
        createElement: (tag) => {
            const attrs = {};
            return {
                tagName: tag.toUpperCase(),
                id: "",
                className: "",
                textContent: "",
                style: { cssText: "", display: "" },
                setAttribute: (k, v) => { attrs[k] = String(v); },
                getAttribute: (k) => (k in attrs ? attrs[k] : null),
            };
        },
    };
    const window = {
        ...windowTarget,
        location,
        crypto: globalThis.crypto,
        history: {
            state: null,
            replaceState: (state, title, url) => { replaced.push(String(url)); href = new URL(url, href).toString(); },
        },
    };
    const fetchState = makeFetch();
    globalThis.window = window;
    globalThis.document = document;
    globalThis.localStorage = makeStorage();
    globalThis.sessionStorage = makeStorage();
    globalThis.fetch = fetchState.fetch;
    return {
        window,
        document,
        fetch: fetchState,
        replaced,
        setUrl: (url) => { href = new URL(url, href).toString(); },
        getUrl: () => href,
        setHidden: (hidden) => {
            document.hidden = hidden;
            document.dispatchEvent({ type: "visibilitychange" });
        },
        goOnline: () => window.dispatchEvent({ type: "online" }),
    };
};

/** Let pending promise callbacks run (setImmediate is not mocked by mock.timers here). */
export const flush = async (rounds = 5) => {
    for(let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};
