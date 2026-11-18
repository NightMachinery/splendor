import { createHash } from "node:crypto";
import { devices, type Browser, type BrowserContext, type Page, type Request, type TestInfo } from "@playwright/test";
import { test, expect, stack, VERSIONS, seedFor, attachGameFailure } from "./lib/e2e.js";
import { playGame, BOARD_PATHS, isCitiesVersion } from "./lib/bot.mjs";
import { takeTokensThroughUi } from "./lib/ui-actor.js";
import { findHorizontalOverflow, findCoveredControls, settle, formatOffenders, type Offender, type CoveredControl } from "../util/layout.js";
import type { SplendorApi, User } from "./lib/splendor-api.mjs";

// A whole 2-player game per version on the real stack, watched by both
// players at once: seat 1 on a desktop browser (1280x800), seat 2 on an
// emulated phone with touch (Pixel 7 in Chromium, iPhone 14 in WebKit).
// The bot drives the game. E2E_UI_TURNS=all plays token moves through the
// actual dialogs by desktop click and phone tap.
//
// Checked on the way:
// - after every action both boards render exactly the served state: their
//   data-splendor-state-hash equals the MD5 of the Game Service body, and
//   data-splendor-turn names the player to move;
// - every E2E_DOM_EVERY turns (and at the start and end) both boards show the
//   bank, each player's prestige, the nobles, the cities and the visible
//   card ids of every tier row exactly as the API state has them;
// - in three idle windows (start, mid-game, game over) of E2E_IDLE_MS each,
//   no seat sends more than 3 game-state GETs: long-polling holds requests
//   instead of busy-looping. At the start and mid-game each seat must also
//   still be polling (a request open or sent), so a dead poll cannot pass;
// - no page error and no console error on either seat (apart from the LS
//   session poll failing once the LS has deleted the finished session);
// - at the end, both seats show the game-over modal, VICTORY only for the
//   winner(s), the modal names every winner, and the Lobby Service has
//   dropped the session.
//
// On each seat's turn the layout probe checks viewport overflow and covered
// dialog controls. DOM comparisons also check for duplicate badges and
// moderation buttons in the opponent's panel.
//
// Full-page screenshots of both seats at the start (the desktop seat's
// turn), mid-game (the first phone turn from E2E_MID_TURN on) and game over
// land in the test's output folder (test-results/...): desktop-start.png,
// mobile-start.png, desktop-mid.png, ..., mobile-game-over.png.
//
// Run: E2E_INSTANCE=<name> pnpm run test:e2e:ui   (see docs/testing.md)

const UI_TURNS = (process.env.E2E_UI_TURNS || "off").toLowerCase();
if (!["off", "desktop", "all", "force"].includes(UI_TURNS)) throw new Error(`E2E_UI_TURNS=${UI_TURNS}: use off, desktop, all or force`);
const LAYOUT_EVERY = Number(process.env.E2E_LAYOUT_EVERY ?? 10);
const DOM_EVERY = Math.max(1, Number(process.env.E2E_DOM_EVERY || 5));
const IDLE_MS = Number(process.env.E2E_IDLE_MS || 5000);
const MID_TURN = Number(process.env.E2E_MID_TURN || 24);
/** Most game-state GETs one seat may send in an idle window. */
const MAX_IDLE_STATE_GETS = 3;
/**
 * The turn UI the layout probe checks for covered controls: the board opens
 * #your-turn-modal (a .modal.show) as soon as it renders the seat's turn.
 * When the redesign replaces it, point this at the new turn UI.
 */
const TURN_UI = ".modal.show";

const SEAT_DEVICES: Record<string, { desktop: string; mobile: string }> = {
    chromium: { desktop: "Desktop Chrome", mobile: "Pixel 7" },
    webkit: { desktop: "Desktop Safari", mobile: "iPhone 14" },
    firefox: { desktop: "Desktop Firefox", mobile: "Desktop Firefox" },
};
const TOKEN_COLOURS = ["Red", "Blue", "Green", "White", "Brown", "Gold"] as const;

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const body = (page: Page) => page.locator("body");

type Seat = {
    label: "desktop" | "mobile";
    user: User;
    context: BrowserContext;
    page: Page;
    /** page errors and console errors, with the time they happened */
    problems: Array<{ at: number; text: string; url?: string }>;
    /** GETs of the game state (long-poll requests) so far */
    stateGets: number;
    /** game-state GETs sent and not answered yet: an open long-poll */
    stateGetsOpen: number;
};

async function openSeat(browser: Browser, label: Seat["label"], deviceName: string, user: User, sessionId: string, version: string): Promise<Seat> {
    const device = devices[deviceName];
    const options = label === "desktop" ? { ...device, viewport: { width: 1280, height: 800 } } : { ...device };
    const context = await browser.newContext({ ...options, baseURL: stack!.baseUrl! });
    await context.addInitScript(({ username, token, displayName }) => {
        // the first about:blank of a new page has no storage; only the board's origin needs it
        if (location.origin === "null") return;
        localStorage.setItem("username", username);
        localStorage.setItem("accessToken", token);
        localStorage.setItem("displayName", displayName);
    }, { username: user.username, token: user.token, displayName: user.displayName ?? user.username });
    const page = await context.newPage();
    const seat: Seat = { label, user, context, page, problems: [], stateGets: 0, stateGetsOpen: 0 };
    const statePath = `/gs/api/sessions/${sessionId}`;
    page.on("pageerror", (err) => seat.problems.push({ at: Date.now(), text: `page error: ${err.message}` }));
    page.on("console", (msg) => {
        if (msg.type() === "error") seat.problems.push({ at: Date.now(), text: `console error: ${msg.text()}`, url: msg.location()?.url });
    });
    const isStateGet = (req: Request) => req.method() === "GET" && new URL(req.url()).pathname === statePath;
    page.on("request", (req) => {
        if (isStateGet(req)) { seat.stateGets++; seat.stateGetsOpen++; }
    });
    const closed = (req: Request) => { if (isStateGet(req)) seat.stateGetsOpen--; };
    page.on("requestfinished", closed);
    page.on("requestfailed", closed);
    await page.goto(`${BOARD_PATHS[version as keyof typeof BOARD_PATHS]}?sessionId=${sessionId}`);
    return seat;
}

/** What one board shows, read from the DOM. */
const readBoard = (page: Page) => page.evaluate((colours) => {
    const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null;
    const ids = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.getAttribute("card-id") ?? "").sort();
    const bank: Record<string, string | null> = {};
    for (const c of colours) bank[c] = text(`#board .board-tokens .${c.toLowerCase()}-token > span`);
    const rows: Record<string, string[]> = {};
    for (const t of [1, 2, 3]) {
        // #board scopes out the copies of a row that the cascade, buy and
        // reserve modals clone into themselves
        rows[`tier${t}Deck`] = ids(`#board .board-cards-row.board-cards-level${t} .board-card-dev:not(.board-card-dev-orient)[card-id]`);
        rows[`tier${t}OrientDeck`] = ids(`#board .board-cards-row.board-cards-level${t} .board-card-dev.board-card-dev-orient[card-id]`);
    }
    const prestige: Record<string, string | null> = { self: text("#player-inventory .player-prestige-points-container > span") };
    for (const el of document.querySelectorAll(".other-players .other-player[pname]")) {
        prestige[el.getAttribute("pname")!] = el.querySelector(".other-prestige-point-container > span")?.textContent?.trim() ?? null;
    }
    return {
        bank, rows, prestige,
        nobles: ids("#board .board-nobles .noble-card[card-id]"),
        cities: ids(".board-container .cities-container .city-card[card-id]"),
    };
}, TOKEN_COLOURS as unknown as string[]);

/** The same, as the API state says it should be for `seat`. */
const expectedBoard = (state: any, seat: Seat) => {
    const ids = (deck: string) => (state[deck]?.visibleCards ?? []).map((c: any) => c.id).sort();
    const bank: Record<string, string> = {};
    for (const c of TOKEN_COLOURS) bank[c] = String(state.tokens?.[c] ?? 0);
    const rows: Record<string, string[]> = {};
    for (const t of [1, 2, 3]) {
        rows[`tier${t}Deck`] = ids(`tier${t}Deck`);
        rows[`tier${t}OrientDeck`] = ids(`tier${t}OrientDeck`);
    }
    const prestige: Record<string, string> = {};
    for (const p of state.players) prestige[p.name === seat.user.username ? "self" : p.name] = String(p.prestigePoints ?? 0);
    return {
        bank, rows, prestige,
        nobles: ids("nobleDeck"),
        cities: isCitiesVersion(state.gameVersion) ? ids("citiesDeck") : [],
    };
};

/**
 * The badges (you, owner, mod, observer) and the moderation buttons (by
 * aria-label) on each other-player tab of one board.
 */
const readBadges = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".other-players .other-player[pname]")]
    .map((el) => ({
        player: el.getAttribute("pname")!,
        badges: [...el.querySelectorAll(".game-player-badge")].map((b) => b.textContent?.trim() ?? ""),
        buttons: [...el.querySelectorAll(".player-action-btn")].map((b) => b.getAttribute("aria-label") ?? ""),
    })));

/**
 * Compare both boards with the API state (soft failures), and note in
 * `badgeDebt` every other-player tab that shows a badge or a moderation
 * button more than once.
 */
async function compareDom(seats: Seat[], state: any, when: string, badgeDebt: string[]) {
    for (const seat of seats) {
        const shown = await readBoard(seat.page);
        expect.soft(shown, `${when}: the ${seat.label} board differs from the API state`).toEqual(expectedBoard(state, seat));
        for (const { player, badges, buttons } of await readBadges(seat.page)) {
            if (new Set(badges).size !== badges.length) badgeDebt.push(`${when}, ${seat.label} seat, ${player}: badges ${badges.join(", ")}`);
            if (new Set(buttons).size !== buttons.length) badgeDebt.push(`${when}, ${seat.label} seat, ${player}: ${buttons.length} moderation buttons (${[...new Set(buttons)].join(", ")})`);
        }
    }
}

/**
 * Full-page screenshots of both seats, for people to look at. They check
 * nothing, so a capture that fails (a full phone page at device scale can
 * take long on a loaded machine) is noted and does not fail the game.
 */
async function screenshotSeats(seats: Seat[], testInfo: TestInfo, moment: string, shots: string[]) {
    for (const seat of seats) {
        const path = testInfo.outputPath(`${seat.label}-${moment}.png`);
        try {
            await seat.page.screenshot({ path, fullPage: true, animations: "disabled", timeout: 30_000 });
        } catch (err) {
            testInfo.annotations.push({ type: "screenshot-failed", description: `${seat.label}-${moment}: ${String(err).split("\n")[0]}` });
            continue;
        }
        shots.push(path);
        await testInfo.attach(`${seat.label}-${moment}.png`, { path, contentType: "image/png" });
    }
}

/**
 * Count game-state GETs per seat while nothing happens for IDLE_MS. Few
 * requests means the board does not busy-loop; with `live`, each seat must
 * also still be polling (a request open at the end of the window, or one
 * sent during it), so a board that silently stopped polling does not pass.
 * The GS holds a long-poll for up to 30 s, so a healthy seat usually sends 0.
 */
async function idleWindow(seats: Seat[], moment: string, notes: string[], { live = true } = {}) {
    const before = seats.map((s) => s.stateGets);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    const counts = seats.map((s, i) => s.stateGets - before[i]);
    notes.push(`${moment}: ${seats.map((s, i) => `${s.label} ${counts[i]} sent, ${s.stateGetsOpen} open`).join("; ")} `
        + `(game-state GETs in ${IDLE_MS} ms)`);
    seats.forEach((seat, i) => {
        expect.soft(counts[i], `${moment}: the ${seat.label} seat sent ${counts[i]} game-state GETs in ${IDLE_MS} idle ms; `
            + "a working long-poll holds one request open").toBeLessThanOrEqual(MAX_IDLE_STATE_GETS);
        if (live) {
            expect.soft(seat.stateGetsOpen + counts[i], `${moment}: the ${seat.label} seat has stopped polling the game state`)
                .toBeGreaterThan(0);
        }
    });
}

/** Wait until both boards show the state the GS serves now. */
async function waitForSync(api: SplendorApi, seats: Seat[], sessionId: string, state: any, when: string) {
    const hash = md5((await api.getStateText(sessionId)).text);
    const turn = state.gameOver ? "" : state.players[state.turnCounter].name;
    await Promise.all(seats.map(async (seat) => {
        await expect.poll(() => body(seat.page).getAttribute("data-splendor-state-hash"), {
            timeout: 15_000, intervals: [50, 100, 200, 400],
            message: `${when}: the ${seat.label} board did not render the served state`,
        }).toBe(hash);
        await expect(body(seat.page), `${when}: the ${seat.label} board names the wrong player to move`).toHaveAttribute("data-splendor-turn", turn);
    }));
}

test.describe.configure({ mode: "parallel" });

for (const version of VERSIONS) {
    test(`${version}: desktop and phone seats follow a whole 2-player game`, async ({ api, browser, browserName }, testInfo) => {
        test.skip(!stack?.baseUrl, "needs a client origin: set E2E_INSTANCE or E2E_BASE_URL");
        const seed = seedFor("rendered", version, testInfo.project.name);
        const users = await api.createUsers(2, "E2E Board");
        // dealt from the seed on the fake stack, so a rerun replays the game
        const sessionId = await api.createGame({ users, version, dealSeed: seed });
        const names = SEAT_DEVICES[browserName] ?? SEAT_DEVICES.chromium;
        const seats = [
            await openSeat(browser, "desktop", names.desktop, users[0], sessionId, version),
            await openSeat(browser, "mobile", names.mobile, users[1], sessionId, version),
        ];
        const [desktop, mobile] = seats;
        const shots: string[] = [];
        const idleNotes: string[] = [];
        const layout: Array<{ seat: Seat["label"]; turn: number; overflow: Offender[]; covered: CoveredControl[] }> = [];
        /** turns at which each seat's layout was probed */
        const probed: Record<Seat["label"], number[]> = { desktop: [], mobile: [] };
        /** the first turn at which each seat is probed next (on its own turn) */
        const nextProbe = new Map<Seat, number>(seats.map((s) => [s, 0]));
        let midDone = false;
        const badgeDebt: string[] = [];
        const log: string[] = [];
        let gameEndedAt = Infinity;

        try {
            for (const seat of seats) await expect(body(seat.page)).toHaveAttribute("data-splendor-ready", "1", { timeout: 30_000 });
            const initial = await api.getState(sessionId);
            await waitForSync(api, seats, sessionId, initial, "start");
            await compareDom(seats, initial, "start", badgeDebt);
            await screenshotSeats(seats, testInfo, "start", shots);
            await idleWindow(seats, "start", idleNotes);

            const uiSeats = UI_TURNS === "off" ? [] : UI_TURNS === "desktop" ? [desktop] : seats;
            const drivers = uiSeats.map((s) => takeTokensThroughUi(s.page, s.user.username, {
                force: UI_TURNS === "force",
                touch: s === mobile && devices[names.mobile].hasTouch,
            }));
            const actor = drivers.length ? async (info: any) => {
                for (const drive of drivers) if (await drive(info)) return true;
                return false;
            } : undefined;

            /** Probe one seat's layout while its own turn UI is open. */
            const probeLayout = async (seat: Seat, turn: number) => {
                probed[seat.label].push(turn);
                // anime.js card and token flights (clones in #anime-overlay)
                // are driven from script, so settle() does not see them; let
                // them land, or a flight passing over a button reads as cover
                await seat.page.waitForFunction(() => !document.querySelector("#anime-overlay")?.childElementCount, undefined,
                    { timeout: 5000, polling: 100 }).catch(() => undefined);
                await settle(seat.page, { quietMs: 300, timeout: 3000 });
                const open = await seat.page.locator(TURN_UI).count();
                expect.soft(open, `turn ${turn}: the ${seat.label} seat is to move but shows no ${TURN_UI}, `
                    + "so its covered-controls probe sees nothing (update TURN_UI if the turn UI changed)").toBeGreaterThan(0);
                // [id^=ran-]: anime.js token and card flights, transient by design
                const overflow = await findHorizontalOverflow(seat.page, { ignore: ["[id^='ran-']"] });
                // controls of the open turn UI that a tap cannot reach
                const covered = await findCoveredControls(seat.page, TURN_UI);
                if (overflow.length || covered.length) layout.push({ seat: seat.label, turn, overflow, covered });
            };

            const onStep = async ({ state, step, turn, turnEnded }: any) => {
                if (state.gameOver) gameEndedAt = Math.min(gameEndedAt, Date.now());
                await waitForSync(api, seats, sessionId, state, `turn ${turn}, action ${step}`);
                if (!turnEnded || state.gameOver) return;
                if (turn % DOM_EVERY === 0) await compareDom(seats, state, `turn ${turn}`, badgeDebt);
                // Each seat only shows its turn UI on its own turn, so probe
                // the seat that is to move (in a 2-player game the phone moves
                // on odd turns, the desktop on even ones).
                const toMove = seats.find((s) => s.user.username === state.players[state.turnCounter]?.name);
                if (LAYOUT_EVERY > 0 && toMove && turn >= nextProbe.get(toMove)!) {
                    nextProbe.set(toMove, turn + LAYOUT_EVERY);
                    await probeLayout(toMove, turn);
                }
                if (!midDone && turn >= MID_TURN && toMove === mobile) {
                    midDone = true;
                    await screenshotSeats(seats, testInfo, "mid", shots);
                    await idleWindow(seats, `mid-game (turn ${turn}, the phone seat to move)`, idleNotes);
                }
            };

            const result = await playGame({ api, players: users, sessionId, version, seed, actor, onStep, log: (l) => log.push(l) });
            gameEndedAt = Math.min(gameEndedAt, Date.now());
            testInfo.annotations.push({
                type: "game",
                description: `seed ${seed}: ${result.rounds} rounds, ${result.turns} turns, ${result.steps} actions, winners ${result.winners.join(", ")}`,
            });
            await testInfo.attach("moves.log", { body: log.join("\n"), contentType: "text/plain" });

            // Game over on both seats: the modal, VICTORY only for the winner(s).
            await compareDom(seats, result.state, "game over", badgeDebt);
            for (const seat of seats) {
                await expect(body(seat.page)).toHaveAttribute("data-splendor-game-over", "1", { timeout: 15_000 });
                const modal = seat.page.locator("#gameover-modal");
                await expect(modal, `the ${seat.label} seat shows the game-over modal`).toBeVisible({ timeout: 15_000 });
                const won = result.winners.includes(seat.user.username);
                await expect(modal.locator("h1"), `the ${seat.label} seat ${won ? "won" : "lost"}`).toHaveText(won ? "VICTORY" : "GAME OVER");
                const winnersText = modal.locator(".winners-text");
                for (const winner of result.winners) {
                    const displayName = users.find((u) => u.username === winner)?.displayName;
                    await expect(winnersText, `the ${seat.label} seat's game-over modal names the winner`)
                        .toContainText(displayName ?? winner);
                }
            }
            await screenshotSeats(seats, testInfo, "game-over", shots);
            // live: false, a finished board may stop polling
            await idleWindow(seats, "game over", idleNotes, { live: false });
            await expect.poll(() => api.getLobbySession(sessionId), { timeout: 10_000, message: "the LS session must be deleted after game over" }).toBeNull();
        } catch (err) {
            // Playwright's own screenshot: "only-on-failure" captures both pages (test-failed-N.png)
            await attachGameFailure(testInfo, err, log);
            throw err;
        } finally {
            for (const note of idleNotes) testInfo.annotations.push({ type: "idle", description: note });
            if (LAYOUT_EVERY > 0) {
                testInfo.annotations.push({
                    type: "layout-probes",
                    description: (["desktop", "mobile"] as const).map((l) => `${l} seat at turns ${probed[l].join(", ") || "(none)"}`).join("; "),
                });
            }
            testInfo.annotations.push({ type: "screenshots", description: shots.join("\n") });
            for (const seat of seats) await seat.context.close().catch(() => undefined);
        }

        // No page errors or console errors on either seat. One kind is
        // expected: once the game is over the LS deletes the session, and
        // the browser logs the board's LS session poll failing as a failed
        // resource load. The request held open at that moment gets a 406
        // (the LS's long-poll library ends held requests that way when a
        // session is removed; the board retries), and the next one a 400,
        // after which the board stops polling the LS.
        const lsSession = `/ls/api/sessions/${sessionId}`;
        for (const seat of seats) {
            const unexpected = seat.problems.filter((p) => !(p.at >= gameEndedAt - 2000 && p.url && new URL(p.url).pathname === lsSession
                && /status of (400|404|406)\b/.test(p.text)));
            expect.soft(unexpected.map((p) => `${p.text}${p.url ? ` (${p.url})` : ""}`), `errors on the ${seat.label} seat`).toEqual([]);
        }

        const report = layout.map((l) => [
            `${l.seat} seat, turn ${l.turn}:`,
            ...(l.overflow.length ? ["  past window.innerWidth:", formatOffenders(l.overflow)] : []),
            ...(l.covered.length ? ["  covered modal controls:", formatOffenders(l.covered)] : []),
        ].join("\n")).join("\n");
        if (layout.length) {
            testInfo.annotations.push({ type: "layout", description: report });
            await testInfo.attach("layout.json", { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
        }
        if (badgeDebt.length) {
            testInfo.annotations.push({ type: "duplicate-badges", description: badgeDebt.slice(0, 6).join("\n") + (badgeDebt.length > 6 ? `\n(${badgeDebt.length} in all)` : "") });
        }
        expect.soft(layout, `layout problems:\n${report}`).toEqual([]);
        expect.soft(badgeDebt, "other-player tabs that show a badge or a moderation button more than once").toEqual([]);
    });
}
