import { type Page } from "@playwright/test";
import { mockBackend, type MockIdentity } from "./backend-mock.js";

/**
 * Log the page in as `username`: seed the localStorage identity the client
 * reads (settings.js) before any page script runs, and make the mocked Lobby
 * Service answer local-auth, /oauth/username and /api/users for that user.
 *
 * Calling it again (before a reload) switches the identity.
 */
export const mockGetUsername = async (page: Page, username: string, extra: Partial<MockIdentity> = {}) => {
    const backend = await mockBackend(page);
    backend.setIdentity(username, extra);
    const id = backend.identity!;
    await page.addInitScript((seed) => {
        localStorage.setItem("username", seed.username);
        localStorage.setItem("displayName", seed.displayName);
        localStorage.setItem("accessToken", seed.token);
    }, { username: id.username, displayName: id.displayName, token: id.token });
    return backend;
};
