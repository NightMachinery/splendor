import { devices, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { stack, test } from "./lib/e2e.js";
import { takeTokensThroughUi } from "./lib/ui-actor.js";

async function signIn(page: Page, name: string) {
    await page.getByLabel("Display name").fill(name);
    await page.getByRole("button", { name: "Continue" }).click();
}

test("a phone host invites a desktop guest and both can play", async ({ api, browser }, testInfo) => {
    test.skip(!stack?.baseUrl, "needs a client origin");
    const phone = await browser.newContext({
        ...devices[testInfo.project.name.includes("webkit") ? "iPhone 14" : "Pixel 7"],
        viewport: { width: 320, height: 650 },
        baseURL: stack!.baseUrl!,
    });
    const desktop = await browser.newContext({ ...devices["Desktop Chrome"], baseURL: stack!.baseUrl! });
    const tag = randomUUID().slice(0, 8);
    try {
        const host = await phone.newPage();
        const guest = await desktop.newPage();
        await host.goto("/login/");
        await signIn(host, `Host ${tag}`);
        await expect(host).toHaveURL(/\/lobby\/$/);
        const hostUser = await host.evaluate(() => localStorage.getItem("username")!);

        await host.getByText("Create Session", { exact: true }).tap();
        await host.getByRole("button", { name: "Splendor Orient", exact: true }).tap();
        const room = host.locator("tr[session-id][created]");
        await expect(room).toHaveCount(1);
        await expect(room.getByRole("status")).toHaveText("Waiting for 1 more player.");
        await expect(room.getByRole("button", { name: "Start game" })).toBeHidden();
        const sessionId = (await room.getAttribute("session-id"))!;

        // Keep clipboard writes inside this browser page so the test can run on every engine.
        await host.evaluate(() => Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (value: string) => sessionStorage.setItem("testInviteUrl", value) },
        }));
        const invite = new URL("/lobby/", stack!.baseUrl!);
        invite.searchParams.set("invite", sessionId);
        const copyInvite = room.getByRole("button", { name: "Copy invite link" });
        await copyInvite.tap();
        await expect.poll(() => host.evaluate(() => sessionStorage.getItem("testInviteUrl"))).toBe(invite.href);

        await host.evaluate(() => Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async () => { throw new Error("Clipboard unavailable"); } },
        }));
        await copyInvite.tap();
        const fallback = room.getByRole("textbox", { name: "Invite link" });
        await expect(fallback).toBeFocused();
        await expect(fallback).toHaveValue(invite.href);

        await guest.goto(invite.href);
        await expect(guest).toHaveURL(`/login/?${invite.searchParams}`);
        await signIn(guest, `Guest ${tag}`);
        await expect(guest).toHaveURL(invite.href);
        const guestUser = await guest.evaluate(() => localStorage.getItem("username")!);
        const guestRoom = guest.locator(`tr[session-id="${sessionId}"]`);
        await expect(guestRoom).toBeFocused();
        await expect(guestRoom.getByRole("status")).toHaveText("Invited session");
        await expect(guestRoom.getByRole("button", { name: "Copy invite link" })).toBeHidden();
        await expect(guestRoom.getByRole("button", { name: "Join", exact: true })).toBeVisible();
        await guestRoom.getByRole("button", { name: "Join", exact: true }).press("Enter");
        await expect(guestRoom.getByRole("status")).toHaveText("Waiting for the host to start.");
        await expect(guestRoom.getByRole("button", { name: "Play", exact: true })).toBeHidden();
        await expect(room.getByRole("status")).toHaveText("Ready to start with 2 players.");
        await expect.poll(() => host.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        await room.getByRole("button", { name: "Start game" }).tap();
        await expect(copyInvite).toBeHidden();
        await expect(guestRoom.getByRole("status")).toHaveText("Game started.");
        await guestRoom.getByRole("button", { name: "Play", exact: true }).press("Enter");
        await room.getByRole("button", { name: "Play", exact: true }).tap();

        await Promise.all([host, guest].map(async (page) => {
            await expect(page.locator("body")).toHaveAttribute("data-splendor-ready", "1");
            await expect(page.locator(".other-players .other-player")).toHaveCount(1);
        }));
        const state = await api.getState(sessionId);
        expect(state.players.map((player: { name: string }) => player.name).sort()).toEqual([hostUser, guestUser].sort());
        expect(state.tokens.Red).toBe(4);

        const turn = state.players[state.turnCounter].name;
        const players = [
            { page: host, username: hostUser, displayName: `Host ${tag}`, touch: true },
            { page: guest, username: guestUser, displayName: `Guest ${tag}`, touch: false },
        ];
        const first = players.find(({ username }) => username === turn)!;
        const second = players.find(({ username }) => username !== turn)!;
        const expectTurnTitles = (active: typeof first, waiting: typeof second) => Promise.all([
            expect(active.page).toHaveTitle("Your turn | Splendor"),
            expect(waiting.page).toHaveTitle(`${active.displayName}’s turn | Splendor`),
        ]);
        for (const [active, waiting] of [[first, second], [second, first]]) {
            const { page, username, touch } = active;
            await expectTurnTitles(active, waiting);
            await expect(page.locator("body")).toHaveAttribute("data-splendor-turn", username);
            const played = await takeTokensThroughUi(page, username, { touch })({
                player: username,
                move: { action: "TAKE_TOKEN", body: { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} }, reason: "opening turn" },
            });
            expect(played).toBe(true);
        }
        await Promise.all([host, guest].map((page) => expect(page.locator("body")).toHaveAttribute("data-splendor-turn", first.username)));
        await expectTurnTitles(first, second);
        expect((await api.getState(sessionId)).tokens.Red).toBe(2);

        await guest.goto("/lobby/?invite=-1");
        await expect(guest.getByText("The invited session is no longer available.")).toBeVisible();
    } finally {
        await Promise.all([phone.close(), desktop.close()]);
    }
});

test("a phone player can start a practice game and the bot plays with the board closed", async ({ api, browser }, testInfo) => {
    test.skip(!stack?.baseUrl || process.env.E2E_FAKE_STACK === "1", "needs the game server's practice bot");
    const phone = await browser.newContext({
        ...devices[testInfo.project.name.includes("webkit") ? "iPhone 14" : "Pixel 7"],
        viewport: { width: 320, height: 650 },
        baseURL: stack!.baseUrl!,
    });
    try {
        const host = await phone.newPage();
        await host.goto("/login/");
        await signIn(host, `Solo ${randomUUID().slice(0, 8)}`);
        await expect(host).toHaveURL(/\/lobby\/$/);
        const user = await host.evaluate(() => ({
            username: localStorage.getItem("username")!,
            token: localStorage.getItem("accessToken")!,
        }));

        await host.getByText("Create Session", { exact: true }).tap();
        await host.getByText("Play vs bot", { exact: true }).tap();
        await expect(host.getByRole("checkbox", { name: "Play vs bot" })).toBeChecked();
        await host.getByRole("button", { name: "Splendor Orient", exact: true }).tap();
        const room = host.locator("tr[session-id][created]");
        await expect(room.getByRole("status")).toHaveText("Ready to play against the bot.");
        await expect(room.getByText("Practice Bot", { exact: true })).toBeVisible();
        await expect(room.getByRole("button", { name: "Copy invite link" })).toBeHidden();
        await expect.poll(() => host.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        const sessionId = (await room.getAttribute("session-id"))!;
        const lobby = await api.getLobbySession(sessionId);
        expect(lobby.players).toEqual([user.username, lobby.botPlayer]);

        await room.getByRole("button", { name: "Start game" }).tap();
        await room.getByRole("button", { name: "Play", exact: true }).tap();
        await expect(host.locator("body")).toHaveAttribute("data-splendor-ready", "1");
        await expect(host.locator(".other-players")).toContainText("Practice Bot");
        await expect(host).toHaveTitle("Your turn | Splendor");
        const opening = await api.getState(sessionId);
        expect(opening.tokens.Red).toBe(4);
        const botIn = (state: typeof opening) => state.players.find((player: { name: string }) => player.name === lobby.botPlayer);
        const openingBot = botIn(opening);
        expect(openingBot).toBeDefined();
        const waitForBotTurn = (before: typeof openingBot) => expect.poll(async () => {
            const state = await api.getState(sessionId);
            return state.players[state.turnCounter].name === user.username
                && JSON.stringify(botIn(state)) !== JSON.stringify(before);
        }).toBe(true);

        const take = { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} };
        expect(await takeTokensThroughUi(host, user.username, { touch: true })({
            player: user.username,
            move: { action: "TAKE_TOKEN", body: take, reason: "opening turn" },
        })).toBe(true);
        await waitForBotTurn(openingBot);
        await expect(host).toHaveTitle("Your turn | Splendor");
        const boardUrl = host.url();
        await host.close();

        const first = await api.getState(sessionId);
        const spoof = await api.putAction({ ...user, username: lobby.botPlayer }, sessionId, "TAKE_TOKEN", take);
        expect(spoof.status).toBe(401);
        const reply = await api.putAction(user, sessionId, "TAKE_TOKEN", take);
        expect(reply.status, reply.text).toBe(200);
        await waitForBotTurn(botIn(first));

        const reopened = await phone.newPage();
        await reopened.goto(boardUrl);
        await expect(reopened).toHaveTitle("Your turn | Splendor");
        await expect(reopened.locator(".other-players")).toContainText("Practice Bot");

        const save = await phone.request.post("/gs/api/saves", {
            params: { session_id: sessionId, access_token: user.token },
            headers: { "Content-Type": "text/plain" },
            data: "Practice save",
        });
        expect(save.status()).toBe(200);
        const restoredId = await api.createSession(user, "BASE_ORIENT", await save.text());
        const restoredLobby = await api.getLobbySession(restoredId);
        expect(restoredLobby.players).toEqual(lobby.players);
        expect(restoredLobby.botPlayer).toBe(lobby.botPlayer);
        await api.launchSession(user, restoredId);
        const restored = await api.getState(restoredId);
        expect(restored.players).toEqual((await api.getState(sessionId)).players);
    } finally {
        await phone.close();
    }
});
