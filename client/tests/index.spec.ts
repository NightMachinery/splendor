import { test, expect } from "@playwright/test";
import { mockBackend } from "./util/backend-mock.js";
import { mockGetUsername } from "./util/ls-mock.js";

test.describe("title and login", () => {
    test("a first-time visitor on the title page is sent to login", async ({ page }) => {
        await mockBackend(page);
        await page.goto("/");
        await expect(page).toHaveURL(/\/login\/$/, { timeout: 15_000 });
    });

    test("logging in with a display name creates the identity and opens the lobby", async ({ page }) => {
        const backend = await mockBackend(page);
        await page.goto("/login/");

        // The form has a single display-name field.
        await page.locator("form input[type='text']").fill("Ada Lovelace");
        await page.locator("form button[type='submit']").click();

        // The first visit compiles the lobby page in the dev server; allow for it.
        await expect(page).toHaveURL(/\/lobby\/$/, { timeout: 15_000 });
        const stored = await page.evaluate(() => ({
            username: localStorage.getItem("username"),
            displayName: localStorage.getItem("displayName"),
            accessToken: localStorage.getItem("accessToken"),
        }));
        // The mocked LS slugs the display name like AuthTokenService.slug does.
        expect(stored).toEqual({ username: "ada_lovelace", displayName: "Ada Lovelace", accessToken: expect.any(String) });
        const auth = backend.requests.filter((r) => r.method === "POST" && r.path === "/ls/api/local-auth");
        expect(auth.length).toBeGreaterThan(0);
    });

    test("a returning player can continue from the title page to the lobby", async ({ page }) => {
        await mockGetUsername(page, "linus");
        await page.goto("/");
        const button = page.locator(".title-login-button").first();
        // Some layouts skip the title page for known players; accept either.
        await expect(async () => {
            if (new URL(page.url()).pathname.startsWith("/lobby")) return;
            await expect(button).toHaveText(/continue/i, { timeout: 500 });
            await button.click({ timeout: 1000 });
            await expect(page).toHaveURL(/\/lobby\/$/, { timeout: 2000 });
        }).toPass({ timeout: 15_000 });
        await expect(page).toHaveURL(/\/lobby\/$/);
    });
});
