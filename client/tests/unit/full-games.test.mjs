// Whole games: playGame drives the bot through the offline engine for every
// game version and player count, checking every invariant after every action.
// The same driver runs against a real stack in tests/e2e/full-games.api.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playGame, GAME_VERSIONS, total, BotError } from "../e2e/lib/bot.mjs";
import { Engine, FakeApi } from "../fixtures/engine.mjs";

const SEEDS = [1, 2, 3];
/** What the games exercised, summed over all of them. */
const seen = new Map();
const note = (what) => seen.set(what, (seen.get(what) ?? 0) + 1);

const observe = ({ before, move }) => {
    const b = move.body;
    note(move.action);
    if (move.action === "TAKE_TOKEN") {
        if (Object.values(b.takeTokens).includes(2)) note("two of a colour");
        if (total(b.putBackTokens) > 0) note("tokens returned");
    }
    if (move.action === "BUY_CARD") {
        if (b.tokens.Gold) note("gold spent");
        const me = before.players[before.turnCounter];
        if (me.reservedCards.some((c) => c.id === b.cardId)) note("reserved card bought");
    }
};

for (const version of GAME_VERSIONS) {
    for (const players of [2, 3, 4]) {
        test(`${version}, ${players} players: bots play to a rule-abiding end`, async () => {
            for (const seed of SEEDS) {
                const api = new FakeApi({ seed });
                const result = await playGame({ api, players, version, seed, maxTurns: 600, onStep: observe });
                assert.ok(result.rounds <= 60, `${result.rounds} rounds is too slow (seed ${seed})`);
                assert.ok(result.winners.length >= 1);
                assert.ok(Object.values(result.turnsTaken).every((n) => n === result.rounds), JSON.stringify(result.turnsTaken));
                assert.ok(api.calls.every((c) => c.status === 200), "the engine accepted every move");
            }
        });
    }
}

test("the games above exercise the main rule paths", () => {
    for (const what of ["TAKE_TOKEN", "BUY_CARD", "RESERVE_CARD", "CASCADE_1", "CASCADE_2", "CHOOSE_SATCHEL_TOKEN",
        "RESERVE_NOBLE", "CHOOSE_CITY", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",
        "two of a colour", "tokens returned", "gold spent", "reserved card bought"]) {
        assert.ok((seen.get(what) ?? 0) > 0, `no game exercised ${what}; seen: ${JSON.stringify(Object.fromEntries(seen))}`);
    }
});

test("playGame is reproducible for a seed", async () => {
    const a = await playGame({ api: new FakeApi({ seed: 9 }), players: 3, version: "BASE_ORIENT", seed: 9 });
    const b = await playGame({ api: new FakeApi({ seed: 9 }), players: 3, version: "BASE_ORIENT", seed: 9 });
    assert.deepEqual(a.moves, b.moves);
    assert.deepEqual(a.winners, b.winners);
});

/** A FakeApi whose games run on a subclass of Engine (to inject server bugs). */
class BuggyApi extends FakeApi {
    constructor(EngineClass) {
        super({ seed: 5 });
        this.EngineClass = EngineClass;
    }

    async createGame({ users, version }) {
        const id = String(this.nextId++);
        this.games.set(id, new this.EngineClass({ version, players: users.map((u) => u.username), seed: 5 }));
        return id;
    }
}

test("playGame catches a server that crowns the wrong winner", async () => {
    class FewestCardsWins extends Engine {
        finishTurn() {
            super.finishTurn();
            if (this.state.gameOver) {
                // the old bug: fewest dev cards wins, prestige ignored; here simply the poorest player
                const loser = [...this.state.players].sort((x, y) => x.prestigePoints - y.prestigePoints)[0];
                this.state.winners = [loser];
            }
        }
    }
    await assert.rejects(
        playGame({ api: new BuggyApi(FewestCardsWins), players: 2, version: "BASE_ORIENT", seed: 5 }),
        (err) => err instanceof BotError && /winners are .* the rules say/.test(err.message),
    );
});

test("playGame catches a server that ends the game a round late", async () => {
    // A broken checkForWin / isLastTurnOfRound: the round in which someone
    // reached the goal ends, and one more round is played. Turns stay equal
    // and the winners still match the final state, so only the round-end
    // check can see it.
    class OneRoundLate extends Engine {
        finishTurn() {
            const s = this.state;
            if (!this.graced && s.turnCounter === s.players.length - 1 && s.players.some((p) => this.canPlayerWin(p))) {
                this.graced = true;
                s.turnCounter = 0;
                s.curValidActions = ["BUY_CARD", "TAKE_TOKEN", "RESERVE_CARD"];
                s.nobleVisitedThisTurn = false;
                return;
            }
            super.finishTurn();
        }
    }
    for (const [version, players] of [["BASE_ORIENT", 2], ["BASE_ORIENT_CITIES", 3], ["BASE_ORIENT_TRADE_ROUTES", 4]]) {
        await assert.rejects(
            playGame({ api: new BuggyApi(OneRoundLate), players, version, seed: 5 }),
            (err) => err instanceof BotError && /the round ended with .* at the goal, but the game went on/.test(err.message),
            `${version}, ${players} players`,
        );
    }
});

test("playGame catches a server that creates tokens", async () => {
    class FreeGold extends Engine {
        do_TAKE_TOKEN(p, body) {
            const out = super.do_TAKE_TOKEN(p, body);
            p.tokens.Gold += 1;
            return out;
        }
    }
    await assert.rejects(
        playGame({ api: new BuggyApi(FreeGold), players: 2, version: "BASE_ORIENT", seed: 5 }),
        (err) => err instanceof BotError && /Gold tokens are not conserved/.test(err.message) && Array.isArray(err.moves),
    );
});

test("an actor can play moves itself; playGame waits for the state to change", async () => {
    const api = new FakeApi({ seed: 4 });
    let handled = 0;
    const result = await playGame({
        api, players: 2, version: "BASE_ORIENT", seed: 4,
        actor: async ({ move, user, sessionId, step }) => {
            if (step % 5 !== 0) return false;
            handled++;
            const res = await api.putAction(user, sessionId, move.action, move.body);
            assert.equal(res.status, 200);
            return true;
        },
    });
    assert.ok(handled > 3);
    assert.ok(result.winners.length >= 1);
});
