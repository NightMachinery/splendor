import { createHash } from "node:crypto";
import { test, expect, stack, VERSIONS, seedFor, attachGameFailure } from "./lib/e2e.js";
import { playGame, BOARD_PATHS } from "./lib/bot.mjs";
import { takeTokensThroughUi } from "./lib/ui-actor.js";
import { findHorizontalOverflow, findCoveredControls, settle, formatOffenders } from "../util/layout.js";

// A whole 2-player game on the real stack, watched through the real board:
// seat 0 is logged in in the browser, the bot plays both seats. After every
// turn the board must show exactly the state the Game Service serves (the
// board's data-splendor-state-hash is the MD5 of the GS body it rendered).
// On desktop the browser seat's token turns go through the modals, so the
// request bodies the client builds are checked against the real server.
// Every E2E_LAYOUT_EVERY turns the layout probes run; their findings are
// annotations, not failures (the mocked layout suite owns the verdicts).
// At the end the game-over modal must name the winners.
//
// Run: E2E_INSTANCE=<name> pnpm run test:e2e:ui   (see docs/testing.md)

const UI_TURNS = (process.env.E2E_UI_TURNS || "desktop").toLowerCase();
if (!["desktop", "all", "off", "force"].includes(UI_TURNS)) throw new Error(`E2E_UI_TURNS=${UI_TURNS}: use desktop, all, off or force`);
const LAYOUT_EVERY = Number(process.env.E2E_LAYOUT_EVERY || 10);

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const body = (page: import("@playwright/test").Page) => page.locator("body");

test.describe.configure({ mode: "parallel" });

for (const version of VERSIONS) {
    test(`${version}: the board follows a whole bot game`, async ({ api, page, isMobile }, testInfo) => {
        test.skip(!stack?.baseUrl, "needs a client origin: set E2E_INSTANCE or E2E_BASE_URL");
        const seed = seedFor("rendered", version, testInfo.project.name);
        const users = await api.createUsers(2, "E2E Board");
        const [me] = users;
        const sessionId = await api.createGame({ users, version });

        await page.addInitScript(({ username, token, displayName }) => {
            localStorage.setItem("username", username);
            localStorage.setItem("accessToken", token);
            localStorage.setItem("displayName", displayName);
        }, { username: me.username, token: me.token, displayName: me.displayName ?? me.username });
        await page.goto(`${BOARD_PATHS[version as keyof typeof BOARD_PATHS]}?sessionId=${sessionId}`);
        await expect(body(page)).toHaveAttribute("data-splendor-ready", "1", { timeout: 30_000 });

        const uiTurns = UI_TURNS === "all" || UI_TURNS === "force" || (UI_TURNS === "desktop" && !isMobile);
        const ui = takeTokensThroughUi(page, me.username, { force: UI_TURNS === "force" });
        let uiMoves = 0;
        const actor = uiTurns ? async (info: any) => (await ui(info)) && ++uiMoves > 0 : undefined;
        const layoutNotes: string[] = [];

        /** The board must render exactly the GS state, then (sometimes) probe the layout. */
        const onStep = async ({ turnEnded, turn, state }: any) => {
            if (!turnEnded) return;
            const res = await api.getStateText(sessionId);
            const hash = md5(res.text);
            await expect.poll(() => body(page).getAttribute("data-splendor-state-hash"), {
                timeout: 15_000,
                message: `turn ${turn}: the board did not render the served state`,
            }).toBe(hash);
            await expect(body(page)).toHaveAttribute("data-splendor-turn", state.gameOver ? "" : state.players[state.turnCounter].name);
            if (LAYOUT_EVERY > 0 && turn % LAYOUT_EVERY === 0) {
                await settle(page, { quietMs: 300, timeout: 3000 });
                // [id^=ran-]: anime.js token and card flights, transient by design
                const overflow = await findHorizontalOverflow(page, { ignore: ["[id^='ran-']"] });
                const covered = await findCoveredControls(page, ".modal.show");
                if (overflow.length) layoutNotes.push(`turn ${turn}: horizontal overflow\n${formatOffenders(overflow)}`);
                if (covered.length) layoutNotes.push(`turn ${turn}: covered controls\n${formatOffenders(covered)}`);
            }
        };

        const log: string[] = [];
        let result;
        try {
            result = await playGame({ api, players: users, sessionId, version, seed, actor, onStep, log: (l) => log.push(l) });
        } catch (err) {
            await attachGameFailure(testInfo, err, log);
            await testInfo.attach("board.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
            throw err;
        }

        testInfo.annotations.push({
            type: "game",
            description: `seed ${seed}: ${result.rounds} rounds, ${result.steps} actions (${uiMoves} through the UI), winners ${result.winners.join(", ")}`,
        });
        for (const note of layoutNotes) testInfo.annotations.push({ type: "layout", description: note });
        await testInfo.attach("moves.log", { body: log.join("\n"), contentType: "text/plain" });
        if (uiTurns && !isMobile) expect.soft(uiMoves, "no token turn went through the UI").toBeGreaterThan(0);

        await expect(body(page)).toHaveAttribute("data-splendor-game-over", "1", { timeout: 15_000 });
        const modal = page.locator("#gameover-modal");
        await expect(modal).toBeVisible({ timeout: 15_000 });
        // the modal names winners by username
        for (const winner of result.winners) await expect(modal.locator(".winners-text")).toContainText(winner);
        await testInfo.attach("game-over.png", { body: await page.screenshot(), contentType: "image/png" });
    });
}
