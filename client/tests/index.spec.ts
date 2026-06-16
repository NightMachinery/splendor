import { test, expect } from "@playwright/test";

test("Clicking start goes to login page", async ({ page }) => {
    await page.goto("/");

    await page.locator("button:text('Login')").click({ force: true });

    await expect(page).toHaveURL("/login/");
});

