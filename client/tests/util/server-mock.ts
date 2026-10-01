import { type Page } from "@playwright/test";
import { mockBackend } from "./backend-mock.js";
import { type Game } from "./game.js";

export { createBasicGame } from "./game.js";

/**
 * Serve `gamestate` as the Game Service state of `sessionId`. Calling it
 * again replaces the state and wakes any long-poll the client holds, as a
 * real state change would. The 204 "no update" answer is keyed on the MD5 of
 * the exact body, like the real server (simpoll uses DigestUtils.md5Hex).
 */
export const mockGameState = async (page: Page, gamestate: Game | Record<string, unknown> | string, sessionId = "123") => {
    const backend = await mockBackend(page);
    backend.setGame(gamestate, sessionId);
    return backend;
};
