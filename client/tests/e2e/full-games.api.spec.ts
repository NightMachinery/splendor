import { test, expect, VERSIONS, PLAYER_COUNTS, seedFor, attachGameFailure } from "./lib/e2e.js";
import { playGame } from "./lib/bot.mjs";

// Whole games over the REST APIs, no browser: for every game version and
// player count, bots play a game to the end on the real Lobby Service and
// Game Service. playGame checks token conservation, the 10-token and
// 3-reservation limits, bonuses, prestige and card bookkeeping after every
// action, equal turns at the end, and that the winners follow the official
// rule (most prestige among those who reached the goal, then fewest cards).
//
// Run: E2E_INSTANCE=<name> pnpm run test:e2e:api   (see docs/testing.md)

test.describe.configure({ mode: "parallel" });

for (const version of VERSIONS) {
    for (const players of PLAYER_COUNTS) {
        test(`${version}, ${players} players: a whole game ends by the rules`, async ({ api }, testInfo) => {
            const seed = seedFor(version, players);
            const log: string[] = [];
            let result;
            try {
                result = await playGame({ api, players, version, seed, log: (line) => log.push(line) });
            } catch (err) {
                await attachGameFailure(testInfo, err, log);
                throw err;
            }
            testInfo.annotations.push({
                type: "game",
                description: `seed ${seed}: ${result.rounds} rounds, ${result.steps} actions, winners ${result.winners.join(", ")}`,
            });
            await testInfo.attach("moves.log", { body: log.join("\n"), contentType: "text/plain" });

            // The finished game is over for the server too.
            const after = await api.putAction(result.users[0], result.sessionId, "TAKE_TOKEN", { takeTokens: {}, putBackTokens: {} });
            expect.soft(after.status, `an action after game over must be refused: ${after.text}`).toBe(400);
            const names = await api.request("GET", `${api.gsUrl}/api/sessions/${result.sessionId}/players/${encodeURIComponent(result.users[0].username)}/actions`);
            expect.soft(names.status, `the actions endpoint after game over: ${names.text}`).toBe(200);
            // The Lobby Service forgets the session once the game is over.
            await expect.configure({ soft: true }).poll(() => api.getLobbySession(result.sessionId), { timeout: 10_000, message: "LS session removed after game over" }).toBeNull();
        });
    }
}
