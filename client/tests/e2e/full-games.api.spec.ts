import { test, expect, VERSIONS, PLAYER_COUNTS, SEEDS_PER_GAME, seedFor, attachGameFailure } from "./lib/e2e.js";
import { playGame } from "./lib/bot.mjs";

// Whole games over the REST APIs, no browser: for every game version and
// player count, E2E_SEEDS games (default 2, each with its own seed) are
// played by bots to the end on the real Lobby Service and Game Service.
// playGame checks token conservation, the 10-token and 3-reservation limits,
// bonuses, prestige and card bookkeeping after every action, that the game
// ends with the first round in which someone reached the goal, equal turns
// at the end, and that the winners follow the official rule (most prestige
// among those who reached the goal, then fewest cards).
//
// After game over: every further action is refused with 400, the actions
// endpoint answers 200 [] for every player (never a 500), and the Lobby
// Service has deleted the session (GET answers 400 or 404).
//
// Each test leaves a game.json in its output folder and a "game" annotation
// with the seed, rounds, turns, actions, winners and time taken.
//
// Run: E2E_INSTANCE=<name> pnpm run test:e2e:api   (see docs/testing.md)

test.describe.configure({ mode: "parallel" });

for (const version of VERSIONS) {
    for (const players of PLAYER_COUNTS) {
        for (let run = 1; run <= SEEDS_PER_GAME; run++) {
            test(`${version}, ${players} players, game ${run}: a whole game ends by the rules`, async ({ api }, testInfo) => {
                // Game 1 keeps the seed earlier runs used, so its moves stay comparable.
                const seed = run === 1 ? seedFor(version, players) : seedFor(version, players, run);
                const log: string[] = [];
                const started = Date.now();
                let result;
                try {
                    result = await playGame({ api, players, version, seed, log: (line) => log.push(line) });
                } catch (err) {
                    await attachGameFailure(testInfo, err, log);
                    throw err;
                }
                const ms = Date.now() - started;
                const summary = {
                    version, players, seed, sessionId: result.sessionId,
                    rounds: result.rounds, turns: result.turns, actions: result.steps,
                    winners: result.winners, ms,
                    prestige: Object.fromEntries(result.state.players.map((p: any) => [p.name, p.prestigePoints])),
                };
                testInfo.annotations.push({
                    type: "game",
                    description: `seed ${seed}: ${result.rounds} rounds, ${result.turns} turns, ${result.steps} actions, `
                        + `winners ${result.winners.join(", ")}, ${ms} ms`,
                });
                await testInfo.attach("game.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
                await testInfo.attach("moves.log", { body: log.join("\n"), contentType: "text/plain" });

                // The finished game is over for the server too.
                for (const user of result.users) {
                    const after = await api.putAction(user, result.sessionId, "TAKE_TOKEN", { takeTokens: { Red: 1 }, putBackTokens: {} });
                    expect(after.status, `${user.username}: an action after game over must be refused: ${after.text}`).toBe(400);
                    const names = await api.request("GET", `${api.gsUrl}/api/sessions/${result.sessionId}/players/${encodeURIComponent(user.username)}/actions`);
                    expect(names.status, `${user.username}: the actions endpoint after game over: ${names.text}`).toBe(200);
                    expect(JSON.parse(names.text), `${user.username}: actions after game over`).toEqual([]);
                }
                expect(await api.getState(result.sessionId), "a refused action after game over changed the state").toEqual(result.state);
                // The Lobby Service forgets the session once the game is over.
                await expect.poll(() => api.getLobbySession(result.sessionId), {
                    timeout: 10_000,
                    message: "the LS session must be deleted after game over",
                }).toBeNull();
            });
        }
    }
}
