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
        const players = [{ page: host, username: hostUser, touch: true }, { page: guest, username: guestUser, touch: false }];
        const first = players.find(({ username }) => username === turn)!;
        const second = players.find(({ username }) => username !== turn)!;
        for (const { page, username, touch } of [first, second]) {
            await expect(page.locator("body")).toHaveAttribute("data-splendor-turn", username);
            const played = await takeTokensThroughUi(page, username, { touch })({
                player: username,
                move: { action: "TAKE_TOKEN", body: { takeTokens: { Red: 1, Blue: 1, Green: 1 }, putBackTokens: {} }, reason: "opening turn" },
            });
            expect(played).toBe(true);
        }
        await Promise.all([host, guest].map((page) => expect(page.locator("body")).toHaveAttribute("data-splendor-turn", first.username)));
        expect((await api.getState(sessionId)).tokens.Red).toBe(2);

        await guest.goto("/lobby/?invite=-1");
        await expect(guest.getByText("The invited session is no longer available.")).toBeVisible();
    } finally {
        await Promise.all([phone.close(), desktop.close()]);
    }
});
