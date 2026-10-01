// @ts-check
/**
 * An offline stand-in for the Lobby Service and Game Service, backed by the
 * rules mirror in engine.mjs. It speaks the subset of both REST APIs that the
 * web client and tests/e2e/lib/splendor-api.mjs use, so the full-stack specs
 * (tests/e2e/**) can run without Java, Docker or a self-host instance.
 *
 * It checks the tests, the bot and the client against each other. It does not
 * check the real server: the rules here are a copy, and only a run against a
 * real stack (E2E_INSTANCE=...) proves the server right.
 *
 * With `webPort` and `distDir` it also serves a built client (astro build)
 * on a third port, with /ls and /gs routed to the two services, the way
 * Caddy serves a self-host instance. A static build, unlike `astro dev`, has
 * no file watcher, so files changing under client/ mid-run (another session
 * editing, or a watcher event that restarts the dev server) cannot reload
 * the board in the middle of a game.
 *
 * Library:  const stack = await startFakeStack({ seed }); ... await stack.close();
 * CLI:      node tests/fixtures/fake-stack.mjs [--ls-port N] [--gs-port N] [--seed N]
 *                [--web-port N --dist DIR] [--verbose]
 *           prints {"lsUrl": ..., "gsUrl": ..., "baseUrl": ...} and serves until SIGTERM/SIGINT.
 *
 * Playwright starts it for you with E2E_FAKE_STACK=1 (pnpm run test:e2e:fake).
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.mjs";

const md5 = (/** @type {string} */ text) => createHash("md5").update(text, "utf8").digest("hex");
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const COLOURS = ["1E90FF", "DC143C", "2E8B57", "DAA520"];
const VERSIONS = ["BASE_ORIENT", "BASE_ORIENT_CITIES", "BASE_ORIENT_CITIES_NOBLES", "BASE_ORIENT_TRADE_ROUTES"];

/**
 * @typedef {object} FakeStackOptions
 * @property {number} [lsPort]      0 (default) picks a free port
 * @property {number} [gsPort]
 * @property {number} [webPort]     serve `distDir` here too (needs distDir)
 * @property {string} [distDir]     a built client (astro build output)
 * @property {string} [host]        default 127.0.0.1
 * @property {number} [seed]        deck shuffles derive from it and the session number
 * @property {number} [holdMs]      how long a long-poll with an unchanged hash is held before 204 (default 5000)
 * @property {(line: string) => void} [log]
 */

/** @param {FakeStackOptions} [opts] */
export async function startFakeStack(opts = {}) {
    const host = opts.host ?? "127.0.0.1";
    const seed = opts.seed ?? 1;
    const holdMs = opts.holdMs ?? 5000;
    const log = opts.log ?? (() => {});

    /** @type {Map<string, { username: string, displayName: string, preferredColour: string }>} token -> user */
    const users = new Map();
    /** @type {Map<string, any>} id -> LS session */
    const sessions = new Map();
    /** @type {Map<string, Engine>} id -> game */
    const games = new Map();
    let userCount = 0;
    let sessionCount = 0;

    const userOf = (/** @type {string | null} */ token) => (token ? users.get(token) ?? null : null);

    /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} body @param {string} [type] */
    const send = (res, status, body, type = "text/plain; charset=utf-8") => {
        res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
    };
    const sendJson = (/** @type {any} */ res, /** @type {unknown} */ data, status = 200) =>
        send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

    /**
     * Answer at once, or, when the client sends the hash of what it already
     * has, hold until the body changes (204 after holdMs, like the real services).
     * @param {any} res @param {string | null} hash @param {() => string | null} body @param {string} gone
     */
    const longPoll = async (res, hash, body, gone) => {
        const deadline = Date.now() + (hash ? holdMs : 0);
        for (;;) {
            const text = body();
            if (text === null) return send(res, 400, gone);
            if (!hash || md5(text) !== hash) return send(res, 200, text, "application/json; charset=utf-8");
            if (Date.now() >= deadline || res.destroyed) return send(res, 204, "");
            await sleep(50);
        }
    };

    /** @param {import("node:http").IncomingMessage} req */
    const readBody = async (req) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        return text;
    };
    const parse = (/** @type {string} */ text) => {
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return undefined;
        }
    };

    const lobbySession = (/** @type {any} */ s) => ({
        creator: s.creator,
        gameParameters: {
            name: s.game,
            displayName: `Splendor ${s.game.replace(/^splendor_/, "")}`,
            location: "fake-stack",
            maxSessionPlayers: 4,
            minSessionPlayers: 2,
            webSupport: "true",
        },
        launched: s.launched,
        players: s.players,
        savegameid: s.savegame ?? "",
        displayNames: Object.fromEntries(s.players.map((/** @type {string} */ p) => [p, s.displayNames[p] ?? p])),
        displayAliases: {},
        observers: [],
        mods: [],
        tempMods: [],
        playerLocations: {},
    });

    // ------------------------------------------------------------------ LS
    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    const lobby = async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake");
        const path = url.pathname;
        const method = req.method ?? "GET";
        const me = userOf(url.searchParams.get("access_token"));
        let m;

        if (method === "GET" && path === "/api/online") return send(res, 200, `Fake Lobby Service is serving ${users.size} users.`);
        if (method === "POST" && path === "/api/local-auth") {
            const body = parse(await readBody(req));
            if (!body || typeof body.token !== "string" || !/^[0-9a-f]{32,128}$/i.test(body.token)) return send(res, 400, "Invalid token.");
            let user = users.get(body.token);
            if (!user) {
                const slug = String(body.displayName || "player").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "player";
                user = { username: `${slug}${++userCount}`, displayName: String(body.displayName || "Player"), preferredColour: COLOURS[userCount % COLOURS.length] };
                users.set(body.token, user);
            }
            return sendJson(res, { token: body.token, username: user.username, displayName: user.displayName, preferredColour: user.preferredColour, role: "ROLE_PLAYER" });
        }
        if (method === "GET" && path === "/oauth/username") return me ? send(res, 200, me.username) : send(res, 401, "Invalid token.");
        if (method === "GET" && path === "/oauth/role") return me ? sendJson(res, [{ authority: "ROLE_PLAYER" }]) : send(res, 401, "Invalid token.");
        if (method === "GET" && (m = path.match(/^\/api\/users\/([^/]+)$/))) {
            const name = decodeURIComponent(m[1]);
            const user = [...users.values()].find((u) => u.username === name);
            return user ? sendJson(res, { name, preferredColour: user.preferredColour, role: "ROLE_PLAYER" }) : send(res, 400, "No such user.");
        }
        if (method === "GET" && path === "/api/sessions") {
            return longPoll(res, url.searchParams.get("hash"),
                () => JSON.stringify({ sessions: Object.fromEntries([...sessions].map(([id, s]) => [id, lobbySession(s)])) }), "");
        }
        if (method === "POST" && path === "/api/sessions") {
            const body = parse(await readBody(req));
            if (!me) return send(res, 401, "Invalid token.");
            if (!body || body.creator !== me.username) return send(res, 400, "Creator must be the token's owner.");
            if (!VERSIONS.includes(String(body.game).replace(/^splendor_/, ""))) return send(res, 400, `Unknown game service ${body.game}.`);
            // 63-bit ids, too big for a JS number, like the real LS
            const id = (4611686018427387000n + BigInt(++sessionCount)).toString();
            sessions.set(id, { creator: me.username, game: body.game, savegame: body.savegame ?? "", players: [me.username], displayNames: { [me.username]: me.displayName }, launched: false });
            return send(res, 200, id);
        }
        if ((m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
            const id = m[1];
            if (method === "GET") {
                return longPoll(res, url.searchParams.get("hash"), () => {
                    const s = sessions.get(id);
                    return s ? JSON.stringify(lobbySession(s)) : null;
                }, "Session not found.");
            }
            const s = sessions.get(id);
            if (!s) return send(res, 400, "Session not found.");
            if (!me) return send(res, 401, "Invalid token.");
            if (method === "POST") {
                if (me.username !== s.creator) return send(res, 400, "Only the creator can launch.");
                if (s.launched || s.players.length < 2) return send(res, 400, "Cannot launch.");
                s.launched = true;
                const version = s.game.replace(/^splendor_/, "");
                const colours = s.players.map((/** @type {string} */ p) => [...users.values()].find((u) => u.username === p)?.preferredColour ?? "1E90FF");
                games.set(id, new Engine({ version, players: s.players, seed: seed * 1000 + sessionCount, colours }));
                log(`launched ${id}: ${version}, ${s.players.join(", ")}`);
                return send(res, 200, "");
            }
            if (method === "DELETE") {
                sessions.delete(id);
                games.delete(id);
                return send(res, 200, "");
            }
        }
        if ((m = path.match(/^\/api\/sessions\/([^/]+)\/players\/([^/]+)$/))) {
            const s = sessions.get(m[1]);
            const name = decodeURIComponent(m[2]);
            if (!s) return send(res, 400, "Session not found.");
            if (!me || me.username !== name) return send(res, 401, "Invalid token.");
            if (method === "PUT") {
                if (s.launched || s.players.length >= 4) return send(res, 400, "Cannot join.");
                if (!s.players.includes(name)) s.players.push(name);
                s.displayNames[name] = me.displayName;
                return send(res, 200, "");
            }
            if (method === "DELETE") {
                s.players = s.players.filter((/** @type {string} */ p) => p !== name);
                return send(res, 200, "");
            }
        }
        if (method === "GET" && /^\/api\/gameservices(\/[^/]+)?(\/savegames)?$/.test(path)) return sendJson(res, []);
        log(`LS: unhandled ${method} ${path}`);
        return send(res, 404, `Fake LS does not serve ${method} ${path}`);
    };

    // ------------------------------------------------------------------ GS
    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    const game = async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake");
        const path = url.pathname;
        const method = req.method ?? "GET";
        let m;

        if (method === "GET" && path === "/api/online") return send(res, 200, `Fake Game Service has ${games.size} sessions.`);
        if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
            const id = m[1];
            return longPoll(res, url.searchParams.get("hash"), () => games.get(id)?.text() ?? null,
                `There is no session associated this session ID: ${id}.`);
        }
        if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)\/players\/([^/]+)\/actions$/))) {
            const engine = games.get(m[1]);
            const name = decodeURIComponent(m[2]);
            if (!engine) return send(res, 400, "There is no session associated this session ID.");
            const s = engine.state;
            const player = s.players.findIndex((/** @type {any} */ p) => p.name === name);
            if (player < 0) return send(res, 400, "The specified player does not exist in this session.");
            if (s.gameOver) return sendJson(res, []);
            if (player !== s.turnCounter) return send(res, 400, "This player has no valid actions because it is not their turn.");
            return sendJson(res, s.curValidActions);
        }
        if (method === "PUT" && (m = path.match(/^\/api\/sessions\/([^/]+)\/players\/([^/]+)\/actions\/([A-Za-z0-9_]+)$/))) {
            const [, id, rawName, action] = m;
            const name = decodeURIComponent(rawName);
            const text = await readBody(req);
            const engine = games.get(id);
            if (!engine) return send(res, 400, `There is no session associated this session ID: ${id}.`);
            if (!engine.state.players.some((/** @type {any} */ p) => p.name === name)) return send(res, 400, "The specified player does not exist in this session.");
            if (userOf(url.searchParams.get("access_token"))?.username !== name) return send(res, 401, "Token does not match requested players name.");
            const body = parse(text);
            if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return send(res, 400, "Action body must be a JSON object.");
            if (engine.state.gameOver) return send(res, 400, "The game is over.");
            if (!engine.state.curValidActions.includes(action)) return send(res, 400, `Given action is not valid: ${action}`);
            const result = engine.act(name, action, body);
            log(`${id} ${name} ${action} ${text} -> ${result.status} ${result.text}`);
            if (!result.ok) return send(res, result.status, result.text);
            // the GS deletes the LS session once the game ends
            if (engine.state.gameOver) sessions.delete(id);
            return send(res, 200, "");
        }
        if (method === "GET" && path === "/api/saves") return sendJson(res, []);
        log(`GS: unhandled ${method} ${path}`);
        return send(res, 404, `Fake GS does not serve ${method} ${path}`);
    };

    /** @param {(req: any, res: any) => Promise<unknown>} handler @param {number} port */
    const listen = (handler, port) => new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            handler(req, res).catch((err) => {
                log(`error: ${err?.stack ?? err}`);
                if (!res.headersSent) send(res, 500, String(err?.message ?? err));
                else res.end();
            });
        });
        server.on("error", reject);
        server.listen(port, host, () => resolve(server));
    });

    // ---------------------------------------------------------------- web
    const TYPES = {
        ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
        ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    };
    const dist = opts.distDir ? resolve(opts.distDir) : null;
    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    const web = async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake");
        // /ls/... and /gs/... go to the services with the prefix stripped, as Caddy's handle_path does
        const service = url.pathname.match(/^\/(ls|gs)(\/.*)?$/);
        if (service) {
            req.url = (service[2] || "/") + url.search;
            return service[1] === "ls" ? lobby(req, res) : game(req, res);
        }
        if (!dist || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, "Not found.");
        let file = normalize(join(dist, decodeURIComponent(url.pathname)));
        if (file !== dist && !file.startsWith(dist + sep)) return send(res, 403, "Forbidden.");
        const info = await stat(file).catch(() => null);
        if (info?.isDirectory()) file = join(file, "index.html");
        const body = await readFile(file).catch(() => null);
        if (!body) return send(res, 404, `Not found: ${url.pathname}`);
        res.writeHead(200, { "content-type": TYPES[/** @type {keyof typeof TYPES} */ (extname(file).toLowerCase())] ?? "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : body);
    };

    const lsServer = /** @type {import("node:http").Server} */ (await listen(lobby, opts.lsPort ?? 0));
    const gsServer = /** @type {import("node:http").Server} */ (await listen(game, opts.gsPort ?? 0));
    const webServer = opts.webPort !== undefined || dist
        ? /** @type {import("node:http").Server} */ (await listen(web, opts.webPort ?? 0))
        : null;
    const portOf = (/** @type {import("node:http").Server} */ s) => /** @type {import("node:net").AddressInfo} */ (s.address()).port;

    return {
        lsUrl: `http://${host}:${portOf(lsServer)}`,
        baseUrl: webServer ? `http://${host}:${portOf(webServer)}` : null,
        gsUrl: `http://${host}:${portOf(gsServer)}`,
        games,
        sessions,
        close: async () => {
            for (const s of [lsServer, gsServer, ...(webServer ? [webServer] : [])]) {
                s.closeAllConnections();
                await new Promise((r) => s.close(r));
            }
        },
    };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const value = (/** @type {string} */ name) => {
        const i = process.argv.indexOf(`--${name}`);
        return i > 0 ? process.argv[i + 1] : undefined;
    };
    const num = (/** @type {string} */ name, /** @type {number | undefined} */ fallback) => {
        const v = value(name);
        return v === undefined ? fallback : Number(v);
    };
    const verbose = process.argv.includes("--verbose");
    const distDir = value("dist");
    const stack = await startFakeStack({
        lsPort: num("ls-port", 0),
        gsPort: num("gs-port", 0),
        webPort: num("web-port", undefined),
        distDir,
        seed: num("seed", 1),
        log: verbose ? (line) => console.log(line) : undefined,
    });
    console.log(JSON.stringify({ lsUrl: stack.lsUrl, gsUrl: stack.gsUrl, baseUrl: stack.baseUrl }));
    const stop = () => stack.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}
