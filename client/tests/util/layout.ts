import { test, type Page, type TestInfo } from "@playwright/test";

/**
 * Layout probes for phone-sized viewports.
 *
 * `document.documentElement.scrollWidth <= innerWidth` is not a usable check
 * on this app: at phone widths html and body get `overflow-x: hidden`
 * (gameboard.css), which clips overflowing content instead of making the page
 * scroll, so scrollWidth always equals the viewport. These probes look at
 * every element's bounding rectangle instead.
 */

export type Offender = {
    selector: string;
    left: number;
    right: number;
    width: number;
    /** how far past the right edge (or before the left edge) it reaches, in CSS px */
    overflow: number;
    text: string;
};

/**
 * Visible elements whose box extends past the viewport's left or right edge.
 * Only the outermost offender of each subtree is reported (its overflowing
 * children are a consequence). Elements parked entirely off-screen (closed
 * drawers, slide-outs) are not reported: they are hidden by design.
 */
export async function findHorizontalOverflow(page: Page, options: { ignore?: string[]; tolerance?: number } = {}): Promise<Offender[]> {
    const { ignore = [], tolerance = 1 } = options;
    return page.evaluate(({ tol, ignore }) => {
        const vw = window.innerWidth;
        const describe = (el: Element) => {
            const parts: string[] = [];
            let cur: Element | null = el;
            for (let depth = 0; cur && cur !== document.body && depth < 4; depth++) {
                let part = cur.tagName.toLowerCase();
                if (cur.id) { parts.unshift(`${part}#${cur.id}`); break; }
                const cls = [...cur.classList].slice(0, 2).join(".");
                if (cls) part += `.${cls}`;
                parts.unshift(part);
                cur = cur.parentElement;
            }
            return parts.join(" > ");
        };
        const isShown = (el: Element, rect: DOMRect) => {
            if (rect.width === 0 || rect.height === 0) return false;
            const style = getComputedStyle(el);
            return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.01;
        };
        // The part of the box that can actually paint: intersected with every
        // clipping ancestor (overflow other than visible) below body. html and
        // body are deliberately not applied: their overflow-x:hidden is what
        // hides real overflow from scrollWidth checks.
        const visibleBox = (el: Element) => {
            const r = el.getBoundingClientRect();
            let left = r.left;
            let right = r.right;
            let fixed = getComputedStyle(el).position === "fixed";
            for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement && !fixed; a = a.parentElement) {
                const s = getComputedStyle(a);
                if (s.overflowX !== "visible") {
                    const ar = a.getBoundingClientRect();
                    left = Math.max(left, ar.left);
                    right = Math.min(right, ar.right);
                }
                fixed = s.position === "fixed";
            }
            return { left, right, width: right - left, rect: r };
        };
        const overflowOf = (el: Element) => {
            const rect = el.getBoundingClientRect();
            if (!isShown(el, rect)) return null;
            const box = visibleBox(el);
            if (box.width <= 0) return null; // fully clipped by an ancestor
            // Entirely off-canvas: an intentionally parked element, not overflow.
            if (box.left >= vw - tol || box.right <= tol) return null;
            const over = Math.max(box.right - vw, -box.left);
            return over > tol ? { rect: box, over } : null;
        };
        const ignored = (el: Element) => ignore.some((sel) => el.closest(sel));
        const offenders: Offender[] = [];
        const flagged = new Set<Element>();
        for (const el of document.body.querySelectorAll("*")) {
            if (el.closest("script, style, template, noscript") || ignored(el)) continue;
            const hit = overflowOf(el);
            if (!hit) continue;
            flagged.add(el);
            let parent = el.parentElement;
            let nested = false;
            while (parent && parent !== document.body) {
                if (flagged.has(parent)) { nested = true; break; }
                parent = parent.parentElement;
            }
            if (nested) continue;
            offenders.push({
                selector: describe(el),
                left: Math.round(hit.rect.left),
                right: Math.round(hit.rect.right),
                width: Math.round(hit.rect.width),
                overflow: Math.round(hit.over),
                text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40),
            });
        }
        return offenders;
    }, { tol: tolerance, ignore });
}

/**
 * Wait until no finite CSS animation or transition has been running for a
 * short quiet window, so the probes measure the resting layout. A quiet
 * window (not a single check) is needed because some animations start from
 * timers, e.g. the page-transition overlay leaves 400 ms after pageshow.
 * Infinite animations (decorative loops) are ignored.
 */
export async function settle(page: Page, { quietMs = 700, timeout = 6000 } = {}) {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForFunction((quiet) => {
        const w = window as unknown as { __settleQuietSince?: number };
        const busy = document.getAnimations().some((a) => {
            const iterations = a.effect?.getComputedTiming().iterations;
            return iterations !== Infinity && a.playState === "running";
        });
        const now = performance.now();
        if (busy || w.__settleQuietSince === undefined) w.__settleQuietSince = busy ? undefined : now;
        return !busy && w.__settleQuietSince !== undefined && now - w.__settleQuietSince >= quiet;
    }, quietMs, { timeout, polling: 100 }).catch(() => undefined);
}

export type CoveredControl = { selector: string; text: string; coveredBy: string };

/**
 * Visible buttons/controls inside `rootSelector` whose centre point is covered
 * by some other element, so a tap there would go to the wrong target.
 */
export async function findCoveredControls(page: Page, rootSelector: string,
    controlSelector = "button, .btn, [role='button'], board-token-counter, .board-card-dev, .noble-card"): Promise<CoveredControl[]> {
    return page.evaluate(({ rootSelector, controlSelector }) => {
        const describe = (el: Element | null) => {
            if (!el) return "(nothing)";
            const id = el.id ? `#${el.id}` : "";
            const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
            return `${el.tagName.toLowerCase()}${id}${cls}`;
        };
        const out: CoveredControl[] = [];
        for (const root of document.querySelectorAll(rootSelector)) {
            for (const el of root.querySelectorAll(controlSelector)) {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden") continue;
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue; // needs scrolling first
                const top = document.elementFromPoint(x, y);
                if (top && (top === el || el.contains(top) || top.contains(el))) continue;
                out.push({ selector: describe(el), text: (el.textContent || "").trim().slice(0, 30), coveredBy: describe(top) });
            }
        }
        return out;
    }, { rootSelector, controlSelector });
}

/** PW_LAYOUT_STRICT=1 turns every known layout debt back into a hard failure. */
export const LAYOUT_STRICT = process.env.PW_LAYOUT_STRICT === "1";

/**
 * Run `body`; if it fails and `isKnownDebt` is true, record the failure as
 * a `known-layout-debt` annotation and mark the test as an expected failure,
 * so the suite stays green while the debt is documented. If the body passes,
 * the test passes normally (the debt was paid; drop it from the list).
 *
 * The responsive redesign is a later phase; until then this keeps the
 * checks running and visible without blocking unrelated work.
 */
export async function withKnownLayoutDebt(testInfo: TestInfo, isKnownDebt: boolean, reason: string, body: () => Promise<void>) {
    if (!isKnownDebt || LAYOUT_STRICT) return body();
    try {
        await body();
    } catch (err) {
        const first = String((err as Error)?.message ?? err).split("\n").slice(0, 6).join(" | ");
        testInfo.annotations.push({ type: "known-layout-debt", description: `${reason}: ${first}` });
        test.fail(true, `known layout debt: ${reason}`);
        throw err;
    }
}

/** Format offenders for an assertion message. */
export const formatOffenders = (items: Array<Record<string, unknown>>) =>
    items.map((o) => "  " + Object.entries(o).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`).join(" ")).join("\n");
