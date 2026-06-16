import { test, expect } from "@playwright/test";

test("Login goes to lobby", async ({ page }) => {
    await page.goto("/");

    await page.locator("button:text('Login')").click({ force: true });

    await expect(page).toHaveURL("/login/");
});

