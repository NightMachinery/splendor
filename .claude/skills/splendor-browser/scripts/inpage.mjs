// @ts-check
/**
 * Code that runs INSIDE the Splendor page. The exported functions are
 * serialized with Function.prototype.toString, so they must stay
 * self-contained (no imports, no closures over module scope) and synchronous
 * (brave.mjs runs them through AppleScript, which cannot await).
 *
 * Both take { frame } to run against an iframe's window instead of the top
 * window (the Brave phone-width harness).
 *
 *   readiness(opts)  -> { ready, reasons[] }
 *   pageProbe(opts)  -> layout and game facts (fields described in SKILL.md)
 *
 * probeExpression(fn, opts) builds the expression string for Runtime.evaluate.
 */

/**
 * Is the page settled enough to screenshot?
 * @param {{ frame?: string }} [opts]
 */
export function readiness(opts = {}) {
    /** @type {any} */
    const frameEl = opts.frame ? document.querySelector(opts.frame) : null;
    const win = opts.frame ? frameEl && frameEl.contentWindow : window;
    if (!win) return { ready: false, reasons: ["frame not found"] };
    const doc = win.document;
    const reasons = [];
    if (doc.readyState !== "complete") reasons.push(`readyState=${doc.readyState}`);
    if (doc.fonts && doc.fonts.status !== "loaded") reasons.push("fonts loading");
    const path = win.location.pathname;
    const body = doc.body;
    if (!body) return { ready: false, reasons: ["no body"] };
    if (/^\/gameboard/.test(path) && body.dataset.splendorReady !== "1") reasons.push("board not rendered (data-splendor-ready)");
    if (/^\/lobby/.test(path) && body.dataset.splendorLobbyReady !== "1") reasons.push("lobby not rendered (data-splendor-lobby-ready)");
    const overlay = doc.querySelector("#anime-overlay");
    if (overlay && overlay.children.length) reasons.push(`${overlay.children.length} animation clone(s) in #anime-overlay`);
    const vis = (/** @type {any} */ el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true }) : true);
    const hiddenCards = [...doc.querySelectorAll("img.invisible")].filter((img) => img.parentElement && vis(img.parentElement) && !vis(img));
    if (hiddenCards.length) reasons.push(`${hiddenCards.length} card image(s) still .invisible (dealing animation)`);
    const pending = [...doc.images].filter((img) => img.getAttribute("src") && !img.complete);
    if (pending.length) reasons.push(`${pending.length} image(s) loading`);
    // Finite CSS animations and transitions (infinite ones, like a pulsing
    // badge, would never end and are ignored).
    const running = doc.getAnimations ? doc.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
        return typeof end === "number" && Number.isFinite(end);
    }) : [];
    if (running.length) reasons.push(`${running.length} CSS animation(s)/transition(s) running`);
    return { ready: reasons.length === 0, reasons };
}

/**
 * Layout and game-state facts about the current page.
 * @param {{ frame?: string, touch?: boolean, maxList?: number, noIdentity?: boolean }} [opts]
 */
export function pageProbe(opts = {}) {
    /** @type {any} */
    const frameEl = opts.frame ? document.querySelector(opts.frame) : null;
    /** @type {any} */
    const win = opts.frame ? frameEl && frameEl.contentWindow : window;
    if (!win) return { error: "frame not found" };
    const doc = win.document;
    const de = doc.documentElement;
    const body = doc.body;
    const maxList = opts.maxList ?? 25;
    // The layout viewport. On a phone, content wider than the screen makes the
    // browser zoom out, which grows innerWidth; clientWidth stays at the
    // device width, so overflow is measured against that.
    const vw = de.clientWidth || win.innerWidth;
    const vh = Math.min(win.innerHeight, de.clientHeight || win.innerHeight);
    const cs = (/** @type {Element} */ el) => win.getComputedStyle(el);
    const round = (/** @type {number} */ n) => Math.round(n * 10) / 10;
    const vis = (/** @type {any} */ el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true }) : true;
    };
    const describe = (/** @type {Element} */ el) => {
        const part = (/** @type {Element} */ e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "")
            + [...e.classList].slice(0, 2).map((c) => `.${c}`).join("")
            + (e.getAttribute("color") ? `[color=${e.getAttribute("color")}]` : "");
        const parts = [];
        /** @type {Element | null} */
        let e = el;
        while (e && e !== body && e !== de && parts.length < 4) {
            parts.unshift(part(e));
            if (e.id) break;
            e = e.parentElement;
        }
        return parts.join(" > ") || el.tagName.toLowerCase();
    };
    const rect = (/** @type {DOMRect} */ r) => ({ x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) });
    const text = (/** @type {Element | null} */ el, n = 60) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim().slice(0, n) : "");

    // Things that are meant to sit (partly) outside the viewport: the closed
    // off-canvas menu, the parked page-transition curtain, the history
    // drawer's peek, the other-player panels that slide out on hover,
    // animation clones and toasts.
    const nav = doc.querySelector(".navigation");
    const navOpen = !!(nav && nav.classList.contains("active"));
    const history = doc.querySelector("#history");
    const historyOpen = !!(history && history.classList.contains("opened"));
    // offStage: never a finding (clones, templates, toasts, the closed menu,
    // the parked page-transition curtain).
    // excluded: also allowed to stick out of the screen (overflow checks
    // skip it, but its visible part is still checked as a tap target).
    const offStage = (/** @type {Element} */ el) => !!el.closest("#anime-overlay, template, .Toastify, .transition1:not(.is-active)")
        || (!navOpen && !!el.closest(".navigation"));
    const excluded = (/** @type {Element} */ el) => offStage(el) || !!el.closest(".other-player-container")
        || (!historyOpen && !!el.closest("#history"));
    const shownModals = [...doc.querySelectorAll(".modal.show")].filter(vis);

    const all = [...body.querySelectorAll("*")];
    /** The nearest ancestor below body/html whose overflow on `axis` is not visible. @param {Element} el @param {"overflowX" | "overflowY"} axis */
    const innerClipper = (el, axis) => {
        for (let a = el.parentElement; a && a !== body && a !== de; a = a.parentElement) {
            if (cs(a)[axis] !== "visible") return a;
        }
        return null;
    };
    /** Whether el or an ancestor is position:fixed (scrolling cannot move it). @param {Element} el */
    const inFixed = (el) => {
        for (/** @type {Element | null} */ let a = el; a && a !== de; a = a.parentElement) if (cs(a).position === "fixed") return true;
        return false;
    };

    // 1. Elements whose box reaches past the left or right edge, unless an
    //    inner container (not html/body) clips or scrolls them. html/body
    //    overflow-x:hidden is exactly what hides real overflow on phones, so
    //    it does not excuse anything. Only the outermost offender is listed.
    const offenders = new Set();
    const beyond = [];
    for (const el of all) {
        if (excluded(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.right <= vw + 1 && r.left >= -1) continue;
        if (!vis(el)) continue;
        let parentOffender = false;
        for (let a = el.parentElement; a && a !== body; a = a.parentElement) if (offenders.has(a)) { parentOffender = true; break; }
        if (parentOffender) continue;
        if (innerClipper(el, "overflowX")) continue; // reported under clippedX / scrollers instead
        offenders.add(el);
        beyond.push({ el: describe(el), rect: rect(r), overRight: round(Math.max(0, r.right - vw)), overLeft: round(Math.max(0, -r.left)), text: text(el, 40) });
    }
    beyond.sort((a, b) => (b.overRight + b.overLeft) - (a.overRight + a.overLeft));

    // 2. Content below the reachable area: the page cannot scroll far enough
    //    (overflow hidden on html/body, a 100vh layout) or the element sits in
    //    a fixed layer taller than the screen. Measured by actually scrolling
    //    the viewport to its end and back.
    const sx = win.scrollX;
    const sy = win.scrollY;
    win.scrollTo({ left: sx, top: 1e7, behavior: "instant" });
    const maxScrollY = win.scrollY;
    win.scrollTo({ left: sx, top: sy, behavior: "instant" });
    const below = [];
    const belowSet = new Set();
    for (const el of all) {
        if (excluded(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const fixed = inFixed(el);
        const bottom = fixed ? r.bottom : r.bottom + win.scrollY;
        const reach = fixed ? vh : maxScrollY + vh;
        if (bottom <= reach + 1) continue;
        if (!vis(el)) continue;
        let parent = false;
        for (let a = el.parentElement; a && a !== body; a = a.parentElement) if (belowSet.has(a)) { parent = true; break; }
        if (parent) continue;
        if (innerClipper(el, "overflowY")) continue; // reported under clippedY / scrollers instead
        belowSet.add(el);
        below.push({ el: describe(el), fixed, hiddenPx: round(bottom - reach), rect: rect(r), text: text(el, 40) });
    }
    below.sort((a, b) => b.hiddenPx - a.hiddenPx);

    // 3. Containers that cut their content off (overflow hidden/clip), and
    //    scrollers (overflow auto/scroll), for context.
    const clippedX = [];
    const clippedY = [];
    const scrollers = [];
    for (const el of [de, body, ...all]) {
        if (el !== de && el !== body && (excluded(el) || !vis(el))) continue;
        const s = cs(el);
        const sw = el.scrollWidth - el.clientWidth;
        const sh = el.scrollHeight - el.clientHeight;
        const name = el === de ? "html" : el === body ? "body" : describe(el);
        if (sw > 1 && (s.overflowX === "hidden" || s.overflowX === "clip")) clippedX.push({ node: el, el: name, hiddenPx: sw, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth });
        if (sh > 1 && (s.overflowY === "hidden" || s.overflowY === "clip") && el !== de && el !== body) clippedY.push({ el: name, hiddenPx: sh, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight });
        if ((sw > 1 && (s.overflowX === "auto" || s.overflowX === "scroll")) || (sh > 1 && (s.overflowY === "auto" || s.overflowY === "scroll") && el !== de && el !== body)) {
            scrollers.push({ el: name, extraX: Math.max(0, sw), extraY: Math.max(0, sh) });
        }
    }
    // Name what sticks out of each clipping container. A container whose
    // overflow comes only from intentional off-canvas parts (the other-player
    // hover panels, say) is not a finding and is dropped.
    let intentionalClips = 0;
    for (const item of clippedX) {
        const box = item.node.getBoundingClientRect();
        const kids = [];
        for (const k of item.node.querySelectorAll("*")) {
            if (excluded(k)) continue;
            const kr = k.getBoundingClientRect();
            if (kr.width < 1 || kr.height < 1 || (kr.right <= box.right + 1 && kr.left >= box.left - 1)) continue;
            if (kids.some((p) => p.node.contains(k))) continue;
            if (!vis(k)) continue;
            kids.push({ node: k, el: describe(k), overRight: round(Math.max(0, kr.right - box.right)), overLeft: round(Math.max(0, box.left - kr.left)) });
            if (kids.length >= 3) break;
        }
        item.culprits = kids.map(({ node, ...rest }) => rest);
        if (!kids.length) { item.intentional = true; intentionalClips++; }
    }
    const realClippedX = clippedX.filter((i) => !i.intentional);
    for (const item of realClippedX) delete item.node;
    realClippedX.sort((a, b) => b.hiddenPx - a.hiddenPx);
    clippedY.sort((a, b) => b.hiddenPx - a.hiddenPx);

    // 4. Interactive elements: tap target size and whether something covers
    //    them. "Interactive" = a native control, an ARIA role, an on* handler
    //    property, a listener seen through the DevTools getEventListeners
    //    helper (only when the caller enabled the command line API), or the
    //    outermost element with cursor:pointer.
    const interactiveSel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [onclick], [tabindex]:not([tabindex='-1'])";
    const TAP = ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"];
    // @ts-ignore getEventListeners only exists with includeCommandLineAPI
    const gel = typeof getEventListeners === "function" ? getEventListeners : null; // eslint-disable-line no-undef
    const big = 0.3 * vw * vh; // a listener on a big container is event delegation, not a control
    const hasHandler = (/** @type {any} */ el) => {
        if (TAP.some((t) => typeof el[`on${t}`] === "function")) return true;
        if (!gel) return false;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > big) return false;
        try {
            const l = gel(el);
            return TAP.some((t) => l[t] && l[t].length);
        } catch { return false; }
    };
    const interactive = [];
    for (const el of all) {
        if (offStage(el) || !vis(el)) continue;
        const pointer = cs(el).cursor === "pointer";
        const parentPointer = el.parentElement ? cs(el.parentElement).cursor === "pointer" : false;
        if (el.matches(interactiveSel) || hasHandler(el) || (pointer && !parentPointer)) interactive.push(el);
    }
    const small = [];
    const covered = [];
    for (const el of interactive) {
        const r = el.getBoundingClientRect();
        const inModal = shownModals.some((m) => m.contains(el));
        const underModal = shownModals.length > 0 && !inModal;
        if (opts.touch && (r.width < 44 || r.height < 44) && !underModal) {
            small.push({ el: describe(el), w: round(r.width), h: round(r.height), text: text(el, 30) });
        }
        if (underModal) continue;
        // Hit-test a 3x3 grid (10%, 50% and 90% across and down), so a
        // partial overlap (an edge or corner under another element) is
        // caught too. A rounded control (a round token or icon button) has
        // no hit region at the corners of its box, so its corner points move
        // to 20% and 80%, which lie inside any border-radius shape (even a
        // full circle or ellipse); the edge midpoints are inside already.
        const ecs = cs(el);
        const rounded = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"]
            .some((k) => parseFloat(/** @type {any} */ (ecs)[k]) > 0);
        const corner = (/** @type {number} */ f, /** @type {number} */ other) => (rounded && other !== 0.5 && f !== 0.5 ? (f < 0.5 ? 0.2 : 0.8) : f);
        const pts = [0.1, 0.5, 0.9].flatMap((fy) => [0.1, 0.5, 0.9].map((fx) => [corner(fx, fy), corner(fy, fx)]))
            .map(([fx, fy]) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy, centre: fx === 0.5 && fy === 0.5 }))
            .filter(({ x, y }) => x >= 0 && y >= 0 && x < vw && y < vh);
        if (!pts.length) continue; // off screen: cannot hit-test
        // A point that lands on an ancestor of the control only counts when
        // the centre is lost as well (pointer-events: none, say). At an edge
        // alone it means the hit region is not the box (a clip-path, a
        // rotated control), and the tap still reaches the control.
        const hits = pts.map(({ x, y, centre }) => {
            const hit = doc.elementFromPoint(x, y);
            if (!hit || hit === el || el.contains(hit)) return null;
            return { hit, centre, ancestor: hit.contains(el) };
        }).filter((h) => h !== null);
        const centreLost = hits.some((h) => h.centre);
        const blocking = hits.filter((h) => !h.ancestor || centreLost);
        if (blocking.length) {
            const by = [...new Set(blocking.map((h) => (h.ancestor ? `${describe(h.hit)} (ancestor takes the tap)` : describe(h.hit))))];
            covered.push({ el: describe(el), by: by.join(" | "), points: `${blocking.length}/${pts.length}`, text: text(el, 30), inModal });
        }
    }
    small.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h));
    covered.sort((a, b) => Number(b.inModal) - Number(a.inModal) || parseInt(b.points, 10) - parseInt(a.points, 10));

    // 5. Images.
    const imgs = [...doc.images].filter((i) => i.getAttribute("src"));
    const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src"));
    const loading = imgs.filter((i) => !i.complete).length;

    // 6. Splendor facts.
    const ds = body.dataset;
    /** @type {Record<string, number | null>} */
    const bank = {};
    for (const t of doc.querySelectorAll("#board .board-tokens board-token")) {
        const n = parseInt(text(t), 10);
        bank[t.getAttribute("color") || "?"] = Number.isFinite(n) ? n : null;
    }
    const shownCount = (/** @type {string} */ sel) => [...doc.querySelectorAll(sel)].filter((el) => {
        const img = el.querySelector("img");
        return vis(el) && (!img || (img.complete && img.naturalWidth > 0 && vis(img)));
    }).length;
    let me = null;
    if (!opts.noIdentity) {
        try { me = win.localStorage.getItem("username"); } catch { /* storage blocked */ }
    }
    const toasts = [...doc.querySelectorAll(".Toastify__toast")].filter(vis).map((t) => text(t, 120));
    const indicator = doc.querySelector("#splendor-connection-indicator");
    const winnersEl = doc.querySelector("#gameover-modal .winners-text");

    return {
        url: win.location.href.replace(/([?&](access_token|migrate)=)[^&]+/g, "$1***"),
        path: win.location.pathname,
        title: doc.title,
        viewport: {
            width: vw, height: vh, innerWidth: win.innerWidth, screenWidth: win.screen.width,
            // On a touch device the layout should be as wide as the screen. Wider
            // means the phone shows the page zoomed out: content wider than the
            // screen, or no width=device-width viewport meta (980px default).
            zoomedOut: !!opts.touch && (vw > win.screen.width + 1 || win.innerWidth > vw + 1),
            metaViewport: (doc.querySelector('meta[name="viewport"]') || { content: null }).content,
            dpr: win.devicePixelRatio,
            pointerCoarse: win.matchMedia("(pointer: coarse)").matches, hoverNone: win.matchMedia("(hover: none)").matches,
            testInsets: de.hasAttribute("data-sp-test-insets"),
        },
        document: {
            scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, clientWidth: de.clientWidth, maxScrollY,
            bodyScrollWidth: body.scrollWidth, htmlOverflowX: cs(de).overflowX, bodyOverflowX: cs(body).overflowX,
            htmlOverflowY: cs(de).overflowY, bodyOverflowY: cs(body).overflowY,
            hscroll: de.scrollWidth > de.clientWidth + 1,
        },
        splendor: {
            me,
            turn: ds.splendorTurn ?? null,
            myTurn: !!me && ds.splendorTurn === me,
            ready: ds.splendorReady === "1",
            lobbyReady: ds.splendorLobbyReady === "1",
            gameOver: ds.splendorGameOver === "1",
            connection: ds.splendorConnection ?? null,
            reconnecting: !!(indicator && vis(indicator)),
            spectating: !!doc.querySelector("#player-inventory.hide"),
            modals: shownModals.map((m) => ({ id: m.id || describe(m), heading: text(m.querySelector("h1, h2, h3, .modal-title, .modal-header"), 80) })),
            winners: winnersEl && vis(winnersEl) ? text(winnersEl, 120) : null,
            bank,
            boardCards: shownCount("#board .board-card-dev[card-id]"),
            boardNobles: shownCount("#board .board-nobles .noble-card[card-id]"),
            cities: shownCount(".cities-container [card-id]"),
            otherPlayers: [...doc.querySelectorAll(".other-player")].filter(vis).length,
            toasts,
            navOpen,
        },
        beyondViewport: { count: beyond.length, items: beyond.slice(0, maxList) },
        belowReach: { count: below.length, items: below.slice(0, maxList) },
        clippedX: { count: realClippedX.length, intentional: intentionalClips, items: realClippedX.slice(0, maxList) },
        clippedY: { count: clippedY.length, items: clippedY.slice(0, 10) },
        scrollers: { count: scrollers.length, items: scrollers.slice(0, 10) },
        tapTargets: opts.touch ? { interactive: interactive.length, small: small.length, listenersSeen: !!gel, items: small.slice(0, maxList) } : null,
        coveredControls: { count: covered.length, items: covered.slice(0, maxList) },
        images: { total: imgs.length, loading, broken: broken.length, brokenSrc: broken.slice(0, 10) },
    };
}

/**
 * The expression that runs one of the functions above in a page.
 * @param {Function} fn @param {Record<string, unknown>} [opts]
 */
export const probeExpression = (fn, opts = {}) => `(${fn.toString()})(${JSON.stringify(opts)})`;
