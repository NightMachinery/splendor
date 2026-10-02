#!/usr/bin/env node
// @ts-check
/**
 * Probe the Splendor client for layout and runtime problems, without
 * screenshots (add --png for them). Same options as shot.mjs (see
 * capture.mjs); prints a findings report per (perspective, viewport):
 *
 *   beyond     elements reaching past the left/right edge of the screen
 *              (html/body overflow-x:hidden does not excuse them)
 *   below      elements ending below what the page can scroll to, or in a
 *              fixed layer taller than the screen
 *   clippedX   containers with overflow hidden that cut content off sideways
 *   small taps controls under 44x44 CSS px (touch viewports only)
 *   covered    controls whose centre or corners are under another element
 *   images, console errors and exceptions, HTTP >= 400 and failed requests
 *   game       whose turn it is, open modals, bank counts, spectating
 *
 * Intentional off-canvas parts (closed menu, history drawer peek, the
 * other-player hover panels, animation clones, toasts) are excluded.
 *
 *   node probe.mjs --identities=FILE --as=p1,p2 --vp=phone,landscape --assert=no-overflow,tap-targets
 *
 * Exit 1 when an --assert fails or a probe errors, 2 on bad usage.
 */
import { run } from "./capture.mjs";

const MAX = Number(process.env.SPLENDOR_PROBE_ITEMS || 6);

/** @param {any} manifest */
function report(manifest) {
    const out = [];
    for (const s of manifest.shots) {
        if (s.error) { out.push(`\n== ${s.perspective}@${s.viewport.name}: ERROR ${s.error}`); continue; }
        const p = s.probe;
        const sp = p.splendor;
        out.push(`\n== ${s.perspective}@${s.viewport.name}${s.variant ? `/${s.variant}` : ""} (${p.viewport.width}x${p.viewport.height}${s.viewport.mobile ? " touch" : ""}) ${p.path}`);
        if (!s.ready) out.push(`   NOT READY: ${s.readyReasons.join("; ")}`);
        if (p.viewport.zoomedOut) out.push(`   ZOOMED OUT: laid out ${p.viewport.width}px wide on a ${p.viewport.screenWidth}px screen; viewport meta: ${p.viewport.metaViewport ?? "missing"}`);
        const game = [];
        if (sp.ready) {
            game.push(sp.gameOver ? `game over, winners: ${sp.winners ?? "?"}` : `turn: ${sp.turn || "-"}${sp.myTurn ? " (mine)" : ""}`);
            game.push(`bank ${Object.entries(sp.bank).map(([k, v]) => `${k}=${v}`).join(" ")}`);
            game.push(`cards ${sp.boardCards}, nobles ${sp.boardNobles}${sp.cities ? `, cities ${sp.cities}` : ""}, others ${sp.otherPlayers}`);
            if (sp.spectating) game.push("spectating");
        }
        if (sp.modals.length) game.push(`modals: ${sp.modals.map((/** @type {any} */ m) => `${m.id}${m.heading ? ` "${m.heading}"` : ""}`).join(", ")}`);
        if (sp.toasts.length) game.push(`toasts: ${sp.toasts.join(" | ")}`);
        if (game.length) out.push(`   ${game.join("; ")}`);
        const list = (/** @type {string} */ title, /** @type {{ count: number, items: any[] } | null} */ group, /** @type {(i: any) => string} */ fmt) => {
            if (!group || !group.count) return;
            out.push(`   ${title}: ${group.count}`);
            for (const i of group.items.slice(0, MAX)) out.push(`     - ${fmt(i)}`);
        };
        list("beyond the screen edge", p.beyondViewport, (i) => `${i.el} ${i.overRight ? `+${i.overRight}px right` : ""}${i.overLeft ? `+${i.overLeft}px left` : ""} ${i.text ? `"${i.text}"` : ""}`);
        list("below the reachable area", p.belowReach, (i) => `${i.el} ${i.hiddenPx}px out of reach${i.fixed ? " (fixed layer)" : ""} ${i.text ? `"${i.text}"` : ""}`);
        list("clipped sideways", p.clippedX, (i) => `${i.el} hides ${i.hiddenPx}px${i.culprits?.length ? `, from ${i.culprits.map((/** @type {any} */ c) => `${c.el} (+${c.overRight || c.overLeft}px)`).join(", ")}` : ""}`);
        list("clipped vertically", p.clippedY, (i) => `${i.el} hides ${i.hiddenPx}px`);
        if (p.tapTargets) list(`tap targets under 44px (of ${p.tapTargets.interactive})`, { count: p.tapTargets.small, items: p.tapTargets.items }, (i) => `${i.el} ${i.w}x${i.h} ${i.text ? `"${i.text}"` : ""}`);
        list("covered controls", p.coveredControls, (i) => `${i.el} by ${i.by} (${i.points})${i.inModal ? " IN MODAL" : ""}`);
        if (p.images.broken) out.push(`   broken images: ${p.images.brokenSrc.join(", ")}`);
        const errs = [...s.events.console, ...s.events.exceptions];
        if (errs.length) { out.push(`   console errors: ${errs.length}`); for (const e of errs.slice(0, MAX)) out.push(`     - ${e.text}`); }
        const net = s.events.network.filter((/** @type {any} */ n) => !n.expected);
        if (net.length) { out.push(`   failed requests: ${net.length}`); for (const n of net.slice(0, MAX)) out.push(`     - ${n.status ?? n.error} ${n.method ?? ""} ${n.url}`); }
        for (const f of s.failures) out.push(`   FAIL ${f}`);
    }
    process.stdout.write(`${out.join("\n")}\n\n`);
}

run(process.argv.slice(2), { tool: "probe.mjs", screenshots: false, report }).catch((err) => {
    process.stderr.write(`probe.mjs: ${err?.stack || err}\n`);
    process.exitCode = 2;
});
