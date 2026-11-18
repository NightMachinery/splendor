#!/usr/bin/env node
// @ts-check
/**
 * Create players and a game to look at, through the real Lobby and Game
 * Service REST APIs, and write the identities to a 0600 JSON file for
 * shot.mjs. Tokens are never printed or passed on a command line.
 *
 *   node seed.mjs --instance=cdp [--version=orient] [--players=2] [--advance=10 | --to-end]
 *   node seed.mjs --from=FILE --advance=5        # continue the game in FILE
 *   node seed.mjs --from=FILE --to-end
 *
 * Options:
 *   --instance=NAME      read baseUrl/lsUrl/gsUrl from .self-host/instances/NAME/instance.json
 *   --base-url=URL       instead of --instance: an origin that proxies /ls and /gs
 *   --ls-url, --gs-url   override the service URLs
 *   --allow-remote       permit a non-loopback stack (it creates users and games!)
 *   --version=V          orient | cities | cities-nobles | tradingposts, or the enum name
 *   --players=N          2 to 4 seats (default 2)
 *   --names=a,b,...      display names (each gets the "cdp-" prefix); default p1, p2, ...
 *   --no-spectator       do not create the extra unseated "spectator" identity
 *   --no-launch          create and join the session but leave it waiting in the lobby
 *   --no-session         only create the users
 *   --advance=N          let the bot play N whole turns after launch
 *   --to-end             let the bot play until the game is over
 *   --seed=N             bot seed (default 1)
 *   --out=FILE           identities file (default $TMPDIR/splendor-browser/identities-*.json)
 *   --verbose            print every bot move
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, writePrivateJson, die as dieWith } from "./util.mjs";

const LIB = new URL("../../../../client/tests/e2e/lib/", import.meta.url);
const { SplendorApi } = await import(new URL("splendor-api.mjs", LIB).href);
const { readInstance, assertLocalStack } = await import(new URL("stack.mjs", LIB).href);
const { nextAction, currentPlayer, stateViolations, BOARD_PATHS, GAME_VERSIONS } = await import(new URL("bot.mjs", LIB).href);

const VERSION_ALIASES = {
    orient: "BASE_ORIENT", base: "BASE_ORIENT",
    cities: "BASE_ORIENT_CITIES", "cities-nobles": "BASE_ORIENT_CITIES_NOBLES", nobles: "BASE_ORIENT_CITIES_NOBLES",
    tradingposts: "BASE_ORIENT_TRADE_ROUTES", "trading-posts": "BASE_ORIENT_TRADE_ROUTES", "trade-routes": "BASE_ORIENT_TRADE_ROUTES",
};

/** @type {(msg: string) => never} */
const die = (msg) => dieWith("seed.mjs", msg);

/** Options that take a value, and plain flags. Anything else is a usage error. */
const VALUED = new Set(["instance", "base-url", "ls-url", "gs-url", "version", "players", "names", "advance", "seed", "out", "from"]);
const FLAGS = new Set(["allow-remote", "no-spectator", "no-launch", "no-session", "to-end", "verbose"]);
/** What --from accepts; the rest describe a new game and would be ignored. */
const WITH_FROM = new Set(["from", "advance", "to-end", "seed", "verbose", "allow-remote"]);

/**
 * Parse and check the command line: unknown options, values given to flags,
 * flags missing their value and repeated options are usage errors, so a
 * typo (--player=3) can never seed a different game than asked for.
 * @param {string[]} argv
 * @returns {Record<string, string | true>}
 */
export function parseSeedArgs(argv) {
    /** @type {Record<string, any>} */
    let args;
    try { args = parseArgs(argv); } catch (err) { die(/** @type {Error} */ (err).message); }
    for (const [k, v] of Object.entries(args)) {
        if (!VALUED.has(k) && !FLAGS.has(k)) die(`unknown option --${k} (see the header of seed.mjs)`);
        if (Array.isArray(v)) die(`--${k} is given more than once`);
        if (VALUED.has(k) && v === true) die(`--${k} needs a value (--${k}=...)`);
        if (FLAGS.has(k) && v !== true) die(`--${k} is a flag and takes no value`);
    }
    if (args.from) {
        const extra = Object.keys(args).filter((k) => !WITH_FROM.has(k));
        if (extra.length) die(`--from continues an existing game; ${extra.map((k) => `--${k}`).join(", ")} only apply when seeding a new one`);
    }
    return args;
}

/** The non-secret part of an identities file, for stdout. @param {any} data @param {string} file */
const summary = (data, file) => ({
    identities: file,
    baseUrl: data.stack.baseUrl,
    sessionId: data.game?.sessionId ?? null,
    version: data.game?.version ?? null,
    boardUrl: data.game?.boardUrl ?? null,
    launched: data.game?.launched ?? false,
    turnsPlayed: data.game?.turnsPlayed ?? 0,
    turn: data.game?.turn ?? null,
    gameOver: data.game?.gameOver ?? false,
    winners: data.game?.winners ?? [],
    perspectives: Object.fromEntries(Object.entries(data.identities).map(([k, v]) => [k, { username: /** @type {any} */ (v).username, displayName: /** @type {any} */ (v).displayName, seat: /** @type {any} */ (v).seat }])),
});

/**
 * Let the bot play whole turns.
 * @param {any} api @param {any} data @param {{ turns: number, toEnd: boolean, seed: number, verbose: boolean }} opts
 */
async function advance(api, data, opts) {
    const sessionId = data.game.sessionId;
    const users = Object.values(data.identities).filter((/** @type {any} */ u) => u.seat !== null);
    const byName = new Map(users.map((/** @type {any} */ u) => [u.username, u]));
    let state = await api.getState(sessionId);
    const limit = opts.toEnd ? 1500 : opts.turns;
    let turns = 0;
    let steps = 0;
    const warnings = [];
    while (!state.gameOver && turns < limit) {
        const me = currentPlayer(state);
        if (!me) throw new Error("no current player in a running game");
        const user = byName.get(me.name);
        if (!user) throw new Error(`seat ${state.turnCounter} is ${me.name}, who is not in the identities file`);
        const move = nextAction(state, me.name, { seed: opts.seed });
        if (!move) throw new Error(`the bot has no move for ${me.name}`);
        const res = await api.putAction(user, sessionId, move.action, move.body);
        if (!res.ok) throw new Error(`${me.name} ${move.action} ${JSON.stringify(move.body)} was rejected: ${res.status} ${res.text.slice(0, 300)}`);
        state = await api.getState(sessionId);
        steps++;
        if (opts.verbose) process.stderr.write(`  ${me.name}: ${move.reason}\n`);
        const v = stateViolations(state, { players: users.length });
        if (v.length && warnings.length < 10) warnings.push(...v.map((/** @type {string} */ s) => `after ${move.action}: ${s}`));
        if (state.gameOver || currentPlayer(state)?.name !== me.name) turns++;
    }
    if (opts.toEnd && !state.gameOver) throw new Error(`no game over after ${limit} turns`);
    data.game.turnsPlayed = (data.game.turnsPlayed || 0) + turns;
    data.game.steps = (data.game.steps || 0) + steps;
    data.game.gameOver = !!state.gameOver;
    data.game.winners = (state.winners || []).map((/** @type {any} */ w) => w.name);
    data.game.turn = state.gameOver ? null : currentPlayer(state)?.name ?? null;
    if (warnings.length) process.stderr.write(`seed.mjs: rule-check warnings (the game kept going):\n  ${warnings.join("\n  ")}\n`);
    return { turns, steps };
}

async function main() {
    const args = parseSeedArgs(process.argv.slice(2));
    const allowRemote = !!args["allow-remote"];
    const seed = Number(args.seed ?? 1);
    if (String(args.seed ?? "1").trim() === "" || !Number.isSafeInteger(seed)) die(`--seed must be a whole number, got ${args.seed}`);
    const turns = args.advance === undefined ? 0 : Number(args.advance);
    if (String(args.advance ?? "0").trim() === "" || !Number.isInteger(turns) || turns < 0) die(`--advance must be a whole number, got ${args.advance}`);
    const toEnd = !!args["to-end"];

    /** @type {any} */
    let data;
    let file;
    if (args.from) {
        file = resolve(String(args.from));
        data = JSON.parse(readFileSync(file, "utf8"));
        if (data.kind !== "splendor-browser-identities") die(`${file} is not a splendor-browser identities file`);
        assertLocalStack(data.stack, { E2E_ALLOW_REMOTE: allowRemote ? "1" : "" });
    } else {
        /** @type {{ instance: string | null, baseUrl: string | null, lsUrl: string, gsUrl: string }} */
        let stack;
        if (args.instance) {
            const inst = readInstance(String(args.instance));
            stack = { instance: String(args.instance), baseUrl: inst.baseUrl, lsUrl: String(args["ls-url"] || inst.lsUrl), gsUrl: String(args["gs-url"] || inst.gsUrl) };
        } else if (args["base-url"]) {
            const base = String(args["base-url"]).replace(/\/+$/, "");
            stack = { instance: null, baseUrl: base, lsUrl: String(args["ls-url"] || `${base}/ls`), gsUrl: String(args["gs-url"] || `${base}/gs`) };
        } else {
            die("pass --instance=NAME (preferred) or --base-url=URL, or --from=FILE");
            return;
        }
        if (!stack.baseUrl) die("the stack has no baseUrl (the browser needs an origin that proxies /ls and /gs)");
        assertLocalStack(stack, { E2E_ALLOW_REMOTE: allowRemote ? "1" : "" });

        const version = VERSION_ALIASES[/** @type {keyof typeof VERSION_ALIASES} */ (String(args.version || "orient").toLowerCase())] ?? String(args.version);
        if (!GAME_VERSIONS.includes(version)) die(`unknown --version ${args.version}; use orient, cities, cities-nobles, tradingposts or one of ${GAME_VERSIONS.join(", ")}`);
        const players = Number(args.players ?? 2);
        if (!Number.isInteger(players) || players < 2 || players > 4) die(`--players must be 2, 3 or 4, got ${args.players}`);
        const names = args.names ? String(args.names).split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (names.length && names.length !== players) die(`--names lists ${names.length} names for ${players} players`);

        const api = new SplendorApi({ lsUrl: stack.lsUrl, gsUrl: stack.gsUrl });
        await api.waitUntilOnline({ timeoutMs: 30_000 });
        /** @type {Record<string, any>} */
        const identities = {};
        const seated = [];
        for (let i = 0; i < players; i++) {
            const u = await api.createUser(`cdp-${names[i] || `p${i + 1}`}`);
            identities[`p${i + 1}`] = { username: u.username, displayName: u.displayName, token: u.token, seat: i };
            seated.push(u);
        }
        if (!args["no-spectator"]) {
            const u = await api.createUser("cdp-spectator");
            identities.spectator = { username: u.username, displayName: u.displayName, token: u.token, seat: null };
        }
        data = {
            kind: "splendor-browser-identities", format: 1,
            createdAt: new Date().toISOString(),
            stack, identities, game: null,
        };
        if (!args["no-session"]) {
            const sessionId = await api.createSession(seated[0], version);
            for (const u of seated.slice(1)) await api.joinSession(u, sessionId);
            const launched = !args["no-launch"];
            if (launched) {
                await api.launchSession(seated[0], sessionId);
                await api.waitForState(sessionId, { timeoutMs: 30_000 });
            }
            const boardPath = BOARD_PATHS[version];
            data.game = {
                sessionId, version, players, launched, boardPath,
                boardUrl: launched ? `${stack.baseUrl}${boardPath}?sessionId=${sessionId}` : null,
                botSeed: seed, turnsPlayed: 0, steps: 0, gameOver: false, winners: [],
                turn: launched ? seated[0].username : null,
            };
        }
        file = resolve(String(args.out || join(tmpdir(), "splendor-browser",
            `identities-${stack.instance || new URL(stack.baseUrl).port || "stack"}-${data.game?.sessionId || Date.now()}.json`)));
        writePrivateJson(file, data);
    }

    if ((turns || toEnd)) {
        if (!data.game?.launched) die("there is no launched game to advance (seeded with --no-launch or --no-session)");
        const api = new SplendorApi({ lsUrl: data.stack.lsUrl, gsUrl: data.stack.gsUrl });
        const t0 = Date.now();
        const done = await advance(api, data, { turns, toEnd, seed: Number(args.seed ?? data.game.botSeed ?? 1), verbose: !!args.verbose });
        data.updatedAt = new Date().toISOString();
        writePrivateJson(file, data);
        process.stderr.write(`seed.mjs: played ${done.turns} turn(s), ${done.steps} action(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
    }
    process.stdout.write(`${JSON.stringify(summary(data, file), null, 2)}\n`);
}

main().catch((err) => {
    process.stderr.write(`seed.mjs: ${err?.stack || err}\n`);
    process.exitCode = 1;
});
