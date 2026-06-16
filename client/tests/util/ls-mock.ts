import { type Page } from '@playwright/test';

// maybe there's a better way to specify the routes (w/ ports)?

export const mockGetUsername = (page: Page, username: string) => {
    page.addInitScript((name) => {
        localStorage.setItem("username", name);
        localStorage.setItem("displayName", name);
        localStorage.setItem("accessToken", `test-token-${name}`);
    }, username);

    page.route("**/oauth/username**", route => {
        route.fulfill({ body: username });
    });

    page.route("**/api/local-auth", async route => {
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                token: `test-token-${username}`,
                username,
                displayName: username,
                preferredColour: "blue",
                role: "ROLE_PLAYER"
            })
        });
    });
};

// export const itemsRoute = (page: Page) => page.route("**/oauth/username", route => {
//     route.fulfill({
//         body: JSON.stringify(
//             [{ id: 1, name: "first item"}, { id: 2, name: "second item"}]
//         )
//     });
// });
