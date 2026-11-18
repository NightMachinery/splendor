import { devices, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { stack, test } from "./lib/e2e.js";
import { takeTokensThroughUi } from "./lib/ui-actor.js";

async function login(page: Page, name: string) {
    await page.goto("/login/");
    await page.getByLabel("Display name").fill(name);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/lobby\/$/);
    return page.evaluate(() => localStorage.getItem("username")!);
}

test("two players create, join, launch and trade turns from phone and desktop", async ({ api, browser }, testInfo) => {
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
        const hostName = `Host ${tag}`;
        const [hostUser, guestUser] = await Promise.all([login(host, hostName), login(guest, `Guest ${tag}`)]);

        await host.getByText("Create Session", { exact: true }).tap();
        await host.getByRole("button", { name: "Splendor Orient", exact: true }).tap();
        const room = host.locator("tr[session-id][created]");
        await expect(room).toHaveCount(1);
        await expect(room.getByRole("status")).toHaveText("Waiting for 1 more player.");
        await expect(room.getByRole("button", { name: "Start game" })).toBeHidden();
        const sessionId = (await room.getAttribute("session-id"))!;
        const guestRoom = guest.locator(`tr[session-id="${sessionId}"]`);
        await guestRoom.getByRole("button", { name: "Join", exact: true }).press("Enter");
        await expect(guestRoom.getByRole("status")).toHaveText("Waiting for the host to start.");
        await expect(guestRoom.getByRole("button", { name: "Play", exact: true })).toBeHidden();
        await expect(room.getByRole("status")).toHaveText("Ready to start with 2 players.");
        await expect.poll(() => host.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        await room.getByRole("button", { name: "Start game" }).tap();
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
    } finally {
        await Promise.all([phone.close(), desktop.close()]);
    }
});
