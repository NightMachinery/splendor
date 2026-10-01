import { type Page, type Request, type Route } from "@playwright/test";
import { createHash } from "node:crypto";

/**
 * One in-memory fake of the Lobby Service (/ls/**) and the Game Service
 * (/gs/**) per page, installed with a single page.route.
 *
 * - Every request under /ls/ or /gs/ is answered here, so nothing leaks to
 *   the Astro dev server or its /ls and /gs proxy. Unknown endpoints get a
 *   404 and are recorded in `unhandled`, so a test can assert on them.
 * - GETs that carry `?hash=` behave like the real long-poll endpoints: both
 *   servers compare the hash with md5Hex(exact response body). When it
 *   matches, the request is held until the content changes or a short
 *   timeout expires, then answered 204. Otherwise the body comes back at once.
 * - Game actions (PUT .../actions/{ACTION}) are recorded in `actions` and
 *   answered 200, as the real server does.
 */

export const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");

/** How long a matching-hash poll is held before the mock answers 204. */
const LONG_POLL_MS = 1500;

export type MockIdentity = {
    username: string;
    displayName: string;
    token: string;
    role: "ROLE_PLAYER" | "ROLE_ADMIN" | "ROLE_SERVICE";
    preferredColour: string;
};

export type RecordedAction = { sessionId: string; player: string; action: string; body: unknown; url: string };
export type RecordedRequest = { method: string; url: string; path: string; hash: string | null };

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "player";

export class MockBackend {
    /** Identity returned by local-auth. When null, local-auth creates one from the posted display name. */
    identity: MockIdentity | null = null;
    /** Game state bodies by session id (exact JSON text, hashed as is). */
    private games = new Map<string, string>();
    /** Lobby Service session objects by session id; generated from the game state when absent. */
    private lobbySessions = new Map<string, Record<string, unknown>>();
    /** Sessions listed by GET /ls/api/sessions. */
    private lobbyList: Record<string, Record<string, unknown>> = {};
    private waiters = new Set<() => void>();

    readonly actions: RecordedAction[] = [];
    readonly requests: RecordedRequest[] = [];
    readonly unhandled: RecordedRequest[] = [];

    constructor(readonly page: Page) {}

    async install() {
        await this.page.route((url) => /^\/(ls|gs)(\/|$)/.test(url.pathname), (route) => this.handle(route));
    }

    setIdentity(username: string, extra: Partial<MockIdentity> = {}) {
        this.identity = {
            username,
            displayName: extra.displayName ?? username,
            token: extra.token ?? `test-token-${username}`,
            role: extra.role ?? "ROLE_PLAYER",
            preferredColour: extra.preferredColour ?? "1E90FF",
        };
        this.changed();
    }

    /** Replace a session's game state. Accepts an object (serialised once) or exact JSON text. */
    setGame(game: unknown, sessionId = "123") {
        this.games.set(sessionId, typeof game === "string" ? game : JSON.stringify(game));
        this.changed();
    }

    setLobbySession(sessionId: string, session: Record<string, unknown>) {
        this.lobbySessions.set(sessionId, session);
        this.changed();
    }

    setLobbyList(sessions: Record<string, Record<string, unknown>>) {
        this.lobbyList = sessions;
        this.changed();
    }

    /** Number of GS state requests seen so far for a session (for long-poll assertions). */
    gameStateRequests(sessionId = "123") {
        return this.requests.filter((r) => r.method === "GET" && r.path === `/gs/api/sessions/${sessionId}`);
    }

    private changed() {
        const waiters = [...this.waiters];
        this.waiters.clear();
        waiters.forEach((wake) => wake());
    }

    private waitForChange(ms: number) {
        return new Promise<void>((resolve) => {
            const wake = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, Math.max(0, ms));
            this.waiters.add(wake);
        });
    }

    private async fulfill(route: Route, options: Parameters<Route["fulfill"]>[0]) {
        try {
            await route.fulfill(options);
        } catch {
            // The page navigated or closed, or the client aborted the request.
        }
    }

    private json(route: Route, data: unknown, status = 200) {
        return this.fulfill(route, { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(data) });
    }

    private text(route: Route, body: string, status = 200) {
        return this.fulfill(route, { status, contentType: "text/plain; charset=utf-8", body });
    }

    /** Answer a long-poll GET the way simpoll/asyncrestlib do. `getBody` returns null for "no such resource". */
    private async longPoll(route: Route, clientHash: string | null, getBody: () => string | null) {
        const deadline = Date.now() + LONG_POLL_MS;
        let body = getBody();
        while (body !== null && clientHash && md5(body) === clientHash && Date.now() < deadline) {
            await this.waitForChange(deadline - Date.now());
            body = getBody();
        }
        if (body === null) return this.text(route, "There is no session associated with this session ID.", 400);
        if (clientHash && md5(body) === clientHash) return this.fulfill(route, { status: 204, body: "" });
        return this.fulfill(route, { status: 200, contentType: "application/json; charset=utf-8", body });
    }

    private lobbySessionFor(sessionId: string): Record<string, unknown> | null {
        const explicit = this.lobbySessions.get(sessionId);
        if (explicit) return explicit;
        const game = this.games.get(sessionId);
        if (!game) return null;
        const state = JSON.parse(game);
        const names: string[] = (state.players || []).map((p: { name: string }) => p.name);
        const version = state.gameVersion || "BASE_ORIENT";
        return lobbySession({ creator: names[0], players: names, version, launched: true });
    }

    private async handle(route: Route) {
        const request: Request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const hash = url.searchParams.get("hash");
        const record = { method, url: url.toString(), path: url.pathname, hash };
        this.requests.push(record);

        const [, service, ...rest] = url.pathname.split("/");
        const path = "/" + rest.join("/");
        const handled = service === "ls"
            ? await this.handleLobby(route, request, method, path, hash)
            : await this.handleGame(route, request, method, path, hash);
        if (handled === false) {
            this.unhandled.push(record);
            await this.text(route, `Not mocked: ${method} ${url.pathname}`, 404);
        }
    }

    private async handleLobby(route: Route, request: Request, method: string, path: string, hash: string | null) {
        let m: RegExpMatchArray | null;
        if (method === "GET" && path === "/api/online") return this.text(route, "Lobby Service is happily serving 2 users.");
        if (method === "POST" && path === "/api/local-auth") {
            const body = safeJson(request.postData()) as { token?: string; displayName?: string } | null;
            if (!this.identity) {
                const displayName = (body?.displayName || "Player").trim() || "Player";
                this.setIdentity(slug(displayName), { displayName, token: body?.token || `test-token-${slug(displayName)}` });
            }
            const id = this.identity!;
            return this.json(route, {
                token: id.token, username: id.username, displayName: id.displayName,
                preferredColour: id.preferredColour, role: id.role,
            });
        }
        if (method === "GET" && path === "/oauth/username") return this.text(route, this.identity?.username ?? "", this.identity ? 200 : 401);
        if (method === "GET" && path === "/oauth/role") return this.json(route, [{ authority: this.identity?.role ?? "ROLE_PLAYER" }]);
        if (method === "GET" && (m = path.match(/^\/api\/users\/([^/]+)$/))) {
            const id = this.identity;
            return this.json(route, {
                name: decodeURIComponent(m[1]), displayName: id?.displayName ?? m[1],
                preferredColour: id?.preferredColour ?? "1E90FF", role: id?.role ?? "ROLE_PLAYER",
            });
        }
        if (method === "GET" && path === "/api/sessions") {
            return this.longPoll(route, hash, () => JSON.stringify({ sessions: this.lobbyList }));
        }
        if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
            const id = m[1];
            return this.longPoll(route, hash, () => {
                const s = this.lobbySessionFor(id);
                return s ? JSON.stringify(s) : null;
            });
        }
        if (method === "GET" && /^\/api\/gameservices\/[^/]+\/savegames$/.test(path)) return this.json(route, []);
        if (method === "GET" && /^\/api\/gameservices(\/[^/]+)?$/.test(path)) return this.json(route, []);
        if (/^\/api\/sessions(\/|$)/.test(path) && ["POST", "PUT", "DELETE"].includes(method)) {
            // create / join / leave / launch / delete / moderation: accept and let the test drive state.
            return this.text(route, method === "POST" && path === "/api/sessions" ? "4242" : "");
        }
        return false;
    }

    private async handleGame(route: Route, request: Request, method: string, path: string, hash: string | null) {
        let m: RegExpMatchArray | null;
        if (method === "GET" && path === "/api/online") return this.text(route, "The server currently has 1 sessions created.");
        if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
            const id = m[1];
            return this.longPoll(route, hash, () => this.games.get(id) ?? null);
        }
        if (method === "PUT" && (m = path.match(/^\/api\/sessions\/([^/]+)\/players\/([^/]+)\/actions\/([A-Z0-9_]+)$/))) {
            this.actions.push({
                sessionId: m[1], player: decodeURIComponent(m[2]), action: m[3],
                body: safeJson(request.postData()), url: request.url(),
            });
            return this.text(route, "");
        }
        if (method === "GET" && path === "/api/saves") return this.json(route, []);
        return false;
    }
}

const safeJson = (text: string | null) => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
};

/** A Lobby Service session object in the shape GET /api/sessions/{id} returns. */
export const lobbySession = (opts: {
    creator: string; players: string[]; version?: string; launched?: boolean; savegameid?: string; maxPlayers?: number;
}) => {
    const version = opts.version ?? "BASE_ORIENT";
    const displayNames = Object.fromEntries(opts.players.map((p) => [p, p]));
    return {
        creator: opts.creator,
        gameParameters: {
            name: `splendor_${version}`,
            displayName: `Splendor ${version}`,
            location: "http://127.0.0.1:33402",
            maxSessionPlayers: opts.maxPlayers ?? 4,
            minSessionPlayers: 2,
            webSupport: "true",
        },
        launched: opts.launched ?? false,
        players: opts.players,
        savegameid: opts.savegameid ?? "",
        displayNames,
        displayAliases: {},
        observers: [],
        mods: [],
        tempMods: [],
        playerLocations: {},
    };
};

const backends = new WeakMap<Page, MockBackend>();

/** The page's mock backend, installed on first use. */
export async function mockBackend(page: Page): Promise<MockBackend> {
    let backend = backends.get(page);
    if (!backend) {
        backend = new MockBackend(page);
        backends.set(page, backend);
        await backend.install();
    }
    return backend;
}
