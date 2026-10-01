import { expect, type Page } from "@playwright/test";

/**
 * Board UI drivers for full-stack games: play some of a seat's moves by
 * clicking through the real modals instead of calling the API, so the
 * request bodies the client builds are checked against the real server.
 *
 * Each driver returns true when it played the move, false when it does not
 * handle that move (playGame then sends it over the API).
 *
 * Selectors follow client/src/components/modals (TakeTurnModal,
 * TakeTokenModal, PutBackTokenModal). The mobile turn-UI redesign will
 * change them; update this file with it.
 */

type Move = { action: string; body: Record<string, any>; reason: string };
type ActorInfo = { move: Move; player: string };

const sum = (m: Record<string, number> | undefined) => Object.values(m || {}).reduce((s, v) => s + (v || 0), 0);

/**
 * Click `selector` `n` times. `force` dispatches the click event directly,
 * for layouts where another element covers the control (known layout debt on
 * phones); a real click is the default so such bugs show up.
 */
async function clickTimes(page: Page, selector: string, n: number, force: boolean) {
    const target = page.locator(selector).first();
    for (let i = 0; i < n; i++) {
        if (force) await target.dispatchEvent("click");
        else await target.click();
    }
}

/**
 * Play TAKE_TOKEN moves of `username` through the take-token and put-back
 * modals. Other moves are left to the API.
 */
export function takeTokensThroughUi(page: Page, username: string, opts: { force?: boolean } = {}) {
    const force = !!opts.force;
    return async ({ move, player }: ActorInfo): Promise<boolean> => {
        if (player !== username || move.action !== "TAKE_TOKEN" || sum(move.body.takeTokens) === 0) return false;
        // Leave moves with a token type the modals have no counter for to the API.
        const counterFor = (modal: string, colour: string) => `${modal} board-token-counter[color="${colour.toLowerCase()}"] .increase`;
        for (const [modal, tokens] of [["#take-token-modal", move.body.takeTokens], ["#put-back-token-modal", move.body.putBackTokens]] as const) {
            for (const [colour, n] of Object.entries((tokens || {}) as Record<string, number>)) {
                if (n > 0 && (await page.locator(counterFor(modal, colour)).count()) === 0) return false;
            }
        }
        const turnModal = page.locator("#your-turn-modal");
        await expect(turnModal).toBeVisible({ timeout: 15_000 });
        await clickTimes(page, "#your-turn-modal #get-tokens-btn", 1, force);

        const take = page.locator("#take-token-modal");
        await expect(take).toBeVisible();
        for (const [colour, n] of Object.entries(move.body.takeTokens as Record<string, number>)) {
            await clickTimes(page, counterFor("#take-token-modal", colour), n, force);
        }
        await clickTimes(page, "#take-token-modal #take-token-confirm-btn", 1, force);

        const putBack = page.locator("#put-back-token-modal");
        await expect(putBack).toBeVisible();
        for (const [colour, n] of Object.entries((move.body.putBackTokens || {}) as Record<string, number>)) {
            await clickTimes(page, counterFor("#put-back-token-modal", colour), n, force);
        }
        await clickTimes(page, "#put-back-token-modal .put-back-token-confirm-btn", 1, force);
        return true;
    };
}
