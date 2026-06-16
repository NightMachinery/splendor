import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";
const LS = process.env.E2E_LS_URL || `${BASE_URL}/ls`;
const GS = process.env.E2E_GS_URL || `${BASE_URL}/gs`;

type Identity = { displayName: string; username: string; token: string };
type GameState = {
  players: Array<{ name: string }>;
  turnCounter: number;
  curValidActions: string[];
  tokens: Record<string, number>;
  tier1Deck: { visibleCards: Array<{ id: string }> };
};

const tokenSeed = () => `pw-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function localAuth(api: APIRequestContext, displayName: string): Promise<Identity> {
  const token = tokenSeed();
  const resp = await api.post(`${LS}/api/local-auth`, {
    data: { token, displayName },
    headers: { "content-type": "application/json" }
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const data = await resp.json();
  return { displayName: data.displayName, username: data.username, token: data.token };
}

async function createSession(api: APIRequestContext, creator: Identity): Promise<string> {
  const resp = await api.post(`${LS}/api/sessions?access_token=${encodeURIComponent(creator.token)}`, {
    data: { creator: creator.username, game: "splendor_BASE_ORIENT", savegame: "" },
    headers: { "content-type": "application/json" }
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return (await resp.text()).trim();
}

async function joinSession(api: APIRequestContext, sessionId: string, player: Identity) {
  const resp = await api.put(`${LS}/api/sessions/${sessionId}/players/${player.username}?access_token=${encodeURIComponent(player.token)}`);
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

async function launchSession(api: APIRequestContext, sessionId: string, creator: Identity) {
  const resp = await api.post(`${LS}/api/sessions/${sessionId}?access_token=${encodeURIComponent(creator.token)}`);
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

async function gameState(api: APIRequestContext, sessionId: string): Promise<GameState> {
  const resp = await api.get(`${GS}/api/sessions/${sessionId}`);
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return await resp.json();
}

async function performAction(api: APIRequestContext, sessionId: string, player: Identity, action: string, data: unknown) {
  const resp = await api.put(`${GS}/api/sessions/${sessionId}/players/${player.username}/actions/${action}?access_token=${encodeURIComponent(player.token)}`, {
    data,
    headers: { "content-type": "application/json" }
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

function emptyTokenMap() {
  return { Red: 0, Blue: 0, Green: 0, White: 0, Brown: 0, Gold: 0 };
}

function takeThreeAvailable(tokens: Record<string, number>) {
  const out = emptyTokenMap();
  for (const color of ["Red", "Blue", "Green", "White", "Brown"] as const) {
    if ((tokens[color] || 0) > 0 && Object.values(out).reduce((a, b) => a + b, 0) < 3) out[color] = 1;
  }
  return out;
}

async function seedIdentity(page: Page, player: Identity) {
  await page.addInitScript(({ username, displayName, token }) => {
    localStorage.setItem("username", username);
    localStorage.setItem("displayName", displayName);
    localStorage.setItem("accessToken", token);
  }, player);
}

test.describe.serial("full-stack playthrough", () => {
  test("launches a real game, plays turns, and renders responsively", async ({ page, browserName, isMobile }) => {
    test.skip(browserName !== "chromium", "Full-stack smoke is configured for Chromium projects.");

    const api = await request.newContext();
    const p1 = await localAuth(api, `E2E Alice ${Date.now()}`);
    const p2 = await localAuth(api, `E2E Bob ${Date.now()}`);
    const sessionId = await createSession(api, p1);
    await joinSession(api, sessionId, p2);
    await launchSession(api, sessionId, p1);

    let state = await gameState(api, sessionId);
    expect(state.players.map((p) => p.name)).toContain(p1.username);
    expect(state.players.map((p) => p.name)).toContain(p2.username);

    await seedIdentity(page, p1);
    await page.goto(`/gameboard/?sessionId=${sessionId}`);
    await expect(page.locator("#board .board-tokens board-token")).toHaveCount(6);
    await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]").first()).toBeVisible();

    if (isMobile) {
      const dims = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
      expect(dims.sw).toBeLessThanOrEqual(dims.iw + 1);
      await expect(page.locator("#player-inventory")).toBeVisible();
      await expect(page.locator("#other-players")).toBeVisible();
    }

    for (let i = 0; i < 4; i++) {
      state = await gameState(api, sessionId);
      const currentName = state.players[state.turnCounter].name;
      const current = currentName === p1.username ? p1 : p2;
      const takeTokens = takeThreeAvailable(state.tokens);
      await performAction(api, sessionId, current, "TAKE_TOKEN", { takeTokens, putBackTokens: emptyTokenMap() });
    }

    state = await gameState(api, sessionId);
    const currentName = state.players[state.turnCounter].name;
    const current = currentName === p1.username ? p1 : p2;
    const cardId = state.tier1Deck.visibleCards[0]?.id;
    expect(cardId).toBeTruthy();
    await performAction(api, sessionId, current, "RESERVE_CARD", { cardId });

    await page.reload();
    await expect(page.locator("#board .board-cards-dev-selectable .board-card-dev img[src]").first()).toBeVisible();
    await expect(page.locator("body")).toContainText("Splendor");
    const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(noHorizontalScroll).toBeTruthy();

    await api.dispose();
  });
});
