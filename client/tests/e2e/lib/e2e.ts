import { test as base, type TestInfo } from "@playwright/test";
import { resolveStack, SKIP_REASON } from "./stack.mjs";
import { SplendorApi } from "./splendor-api.mjs";
import { GAME_VERSIONS } from "./rules.mjs";

/**
 * Shared setup for the full-stack specs (tests/e2e/**).
 *
 * The target stack comes from E2E_INSTANCE or E2E_BASE_URL / E2E_LS_URL /
 * E2E_GS_URL (see stack.mjs); without one every full-stack test skips.
 * Knobs, all optional:
 *   E2E_SEED       bot seed (default 1); each game derives its own from it
 *   E2E_VERSIONS   comma-separated game versions (default: all four)
 *   E2E_PLAYERS    comma-separated player counts (default: 2,3,4)
 *   E2E_UI_TURNS   rendered games: which projects play the browser seat's
 *                  token turns through the UI: "desktop" (default), "all",
 *                  "off", or "force" (all projects, clicks dispatched so
 *                  covered controls do not block)
 *   E2E_LAYOUT_EVERY  rendered games: layout probe every N turns (default 10)
 */

export const stack = resolveStack();
export const SEED = Number(process.env.E2E_SEED || 1);

const list = (value: string | undefined) => (value || "").split(",").map((s) => s.trim()).filter(Boolean);

export const VERSIONS: string[] = list(process.env.E2E_VERSIONS).length ? list(process.env.E2E_VERSIONS) : [...GAME_VERSIONS];
for (const v of VERSIONS) {
    if (!(GAME_VERSIONS as readonly string[]).includes(v)) throw new Error(`E2E_VERSIONS: unknown game version ${v}`);
}
export const PLAYER_COUNTS: number[] = list(process.env.E2E_PLAYERS).length ? list(process.env.E2E_PLAYERS).map(Number) : [2, 3, 4];

/** `test` with an `api` fixture: a SplendorApi for the configured stack, checked online. Skips without a stack. */
export const test = base.extend<{ api: SplendorApi }>({
    // eslint-disable-next-line no-empty-pattern
    api: async ({}, use, testInfo) => {
        testInfo.skip(!stack, SKIP_REASON);
        const api = new SplendorApi({ lsUrl: stack!.lsUrl, gsUrl: stack!.gsUrl });
        await api.waitUntilOnline({ timeoutMs: 30_000 });
        await use(api);
    },
});

export { expect } from "@playwright/test";

/** Attach what a failed game left behind: the move log and, when the error carries it, the state. */
export async function attachGameFailure(testInfo: TestInfo, err: any, log: string[]) {
    await testInfo.attach("moves.log", { body: log.join("\n"), contentType: "text/plain" });
    if (err?.state) await testInfo.attach("state.json", { body: JSON.stringify(err.state, null, 2), contentType: "application/json" });
    if (err?.before) await testInfo.attach("state-before.json", { body: JSON.stringify(err.before, null, 2), contentType: "application/json" });
}

/** A per-game seed, so different games in one run differ but a run is reproducible. */
export const seedFor = (...parts: Array<string | number>) => {
    let h = SEED >>> 0;
    for (const ch of parts.join("|")) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619)) >>> 0;
    return h % 100000;
};
