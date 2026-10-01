# UI foundations

This page documents the shared base of the touch-first board redesign (work package WP-FOUND in the UX spec): the design tokens, the self-hosted display font, the CSS primitives and the SVG sprite. Every other UI package builds on these, so changes here ripple everywhere.

Two terms recur below:

- A **token** is a CSS custom property on `:root` defined in `client/src/styles/sp/tokens.css`, named `--sp-*` (or `--z-*` for the stacking ladder).
- A **layout class** is one of the five page layouts, each selected by one exact media query string: P (portrait phone, the base styles with no query), L (landscape phone), T (tablet), D (desktop and iPad landscape) and W (wide).

## Tokens

File: `client/src/styles/sp/tokens.css`. It is owned by WP-FOUND, then by WP-LAYOUT for the geometry values only, then frozen. A package that needs its own custom property defines it in its own file as `--sp-<package>-*` instead of adding a token.

This is the only file allowed to contain raw `z-index` numbers, `100vh` or `100dvh`, and `env(safe-area-inset-*)`. Everything else reads the tokens, and the CSS lint enforces it.

### Layout classes

The query strings are a contract. Copy them exactly; the lint rejects near misses.

- P: no query.
- L: `@media (orientation: landscape) and (max-height: 500px)`.
- T: `@media (min-width: 700px) and (min-height: 501px)`.
- D: `@media (min-width: 1024px) and (min-height: 501px)`.
- W: `@media (min-width: 1600px) and (min-height: 800px)`.
- Hover polish only: `@media (hover: hover) and (pointer: fine)`.
- Reduced motion: `@media (prefers-reduced-motion: reduce)`.

L never overlaps T, D or W, because they all need a height of at least 501px. D is a subset of T and W a subset of D, so D inherits every T value it does not override, and W inherits D. There is one more, non-layout switch: the gutter grows from 8px to 12px at `(min-width: 400px)`.

### Colour, type, shape and motion

- Colours: `--sp-bg`, `--sp-surface-1`, `--sp-surface-2`, `--sp-line`, `--sp-text`, `--sp-text-muted`, `--sp-gold`, `--sp-gold-ink`, `--sp-ok`, `--sp-warn`, `--sp-danger`, `--sp-focus`, `--sp-scrim` and `--sp-final`, with the values from section 7.1 of the spec.
- Gems: `--sp-gem-white`, `-blue`, `-green`, `-red`, `-brown` and `-gold`. Numeral ink is `--sp-gem-ink-dark` (#161616) on White and Gold and `--sp-gem-ink-light` (#ffffff) on the others.
- Deck tabs: `--sp-tier-1` (green), `--sp-tier-2` (yellow), `--sp-tier-3` (blue) and `--sp-tier-orient`, sampled from the deck backs so no raster is needed.
- Type: `--sp-font-ui` (the system stack) and `--sp-font-display` (Judson, then Georgia). Sizes `--sp-fs-xs` 12px, `-sm` 14px, `-md` 16px (body and inputs, so iOS never zooms), `-lg` 20px and `-xl` 24px, plus `--sp-fs-pip` 11px, the one size allowed below 12px and only inside pips.
- Spacing: `--sp-space-1` to `--sp-space-6` are 4, 8, 12, 16, 24 and 32px.
- Radii: `--sp-r-1` 6px (cards, slots, chips), `--sp-r-2` 10px (buttons), `--sp-r-3` 16px (sheets), `--sp-r-pill`. `--sp-tap` is the 44px minimum control size.
- Motion: `--sp-ease`, `--sp-dur-1` 120ms, `--sp-dur-2` 200ms, `--sp-dur-3` 320ms, and `--sp-motion`, which is 1 normally and 0 under reduced motion. Multiply travel distances by it, for example `translateY(calc(16px * var(--sp-motion)))`, and the movement disappears for viewers who asked for less motion.

Reduced motion is signalled two ways: the `prefers-reduced-motion: reduce` media query, and `html[data-sp-motion="off"]`, which tests and the in-game "Reduce motion" setting set. Both zero `--sp-motion` and cap `--sp-dur-2` and `--sp-dur-3` at 120ms. Flights, sheen, shake and confetti are switched off by the packages that own them, on the same two signals.

### The z ladder

These are the only raw stacking numbers in the client: `--z-backdrop` -1, `--z-board` 0, `--z-raised` 1, `--z-dock` 30, `--z-dock-top` 31 (the fixed bank), `--z-flight` 40, `--z-sheet` 50, `--z-hud` 55, `--z-result` 60, `--z-drawer` 70, `--z-menu-modal` 80 and `--z-toast` 90 (toasts and the connection indicator). Sheets never overlap the HUD region, which is why the HUD can sit above them and the menu stays reachable during a mandatory follow-up.

`--z-backdrop` is not in the spec. It exists for a page backdrop drawn as a fixed `::before` layer behind all content, the replacement for `background-attachment: fixed`.

### Geometry

The geometry tokens hold P values at the top of the file and are overridden per layout class further down:

- `--sp-vh` is `100vh`, or `100dvh` where supported. Use it for every viewport-relative height.
- `--sp-safe-t`, `-r`, `-b` and `-l` are the safe-area insets.
- `--sp-gutter` (8px, 12px from 400px wide, 16px on T and up) and `--sp-content-max` (640px on P, 760px on T).
- Heights: `--sp-hud-h` (48px, 76px with 3-4 players, 56px on T, D and W), `--sp-dock-h` (140px on P, 160px on T, 116px on D and W), and the dock rows `--sp-bank-h`, `--sp-hold-h` and `--sp-bar-h`.
- L rails: `--sp-l-left`, `--sp-l-right`, `--sp-l-hud-h` (76px, 108px with 3-4 players), `--sp-l-goal` and `--sp-l-goals-h`.
- Columns: `--sp-side-w` (the D side column), `--sp-w-left` and `--sp-w-right` (the W outer columns), `--sp-main-w` (the market column on D and W) and `--sp-rail-max` (the bank and holdings width cap: the content width on P and T, 560px on D and W).
- Market: `--sp-deck-w`, `--sp-noble`, `--sp-card-w`, `--sp-card-h` (always 7/5 of the width) and `--sp-pip` (28% of the card width, clamped to 14-22px).

The card widths come out as the spec computes them. Measured in headless Chromium: 52.2px at 375x667, 54.7px at 390x844, 49.7px at 360x800, 60px at 430x932, 72.8px at 844x390, 59.8px at 844x340 with test insets, 108.7px at 820x1180 and 768x1024, 117.6px at 1280x850, 98.1px at 1024x768, 110.5px at 1180x820 and 143.3px at 1920x1080.

Some caveats when using these:

- **Derived tokens resolve where they are declared.** `--sp-card-h` and `--sp-pip` are declared on `:root`, so they follow `--sp-card-w` only as long as it is changed on `:root`. A rule that redeclares `--sp-card-w` on some descendant must redeclare `--sp-card-h` and `--sp-pip` next to it, or they keep the `:root` size.
- **The 3-4 player HUD heights are set on `body`.** `body[data-sp-players="3"]` and `="4"` raise `--sp-hud-h` and `--sp-l-hud-h`. Anything on `html` itself, such as `scroll-padding-top`, still sees the 2-player value through `:root`.
- **`--sp-main-w` assumes the D and W grids use 16px page padding and a 16px column gap.** If WP-LAYOUT chooses other numbers it must update the token in the same commit. Both D and W formulas use `100vw`, which includes a classic (non-overlay) scrollbar, so those pages must not scroll vertically.
- **Test insets.** `html[data-sp-test-insets]` forces the insets to 47px left and right and 21px bottom, which is what a notched iPhone in landscape leaves. Set it from a Playwright init script, but note that init scripts run before the parser has created `<html>`: wait for `document.documentElement` (for example with a MutationObserver on `document`) before setting the attribute.

## The display font

Judson is self-hosted under `client/public/fonts/judson/`, so the app works offline and on an intranet with no request to a font CDN. There are four files, weights 400 and 700 in the latin and latin-ext subsets (about 56KB together), with the SIL Open Font License next to them as `OFL.txt`. The four `@font-face` rules at the top of `tokens.css` use `font-display: swap` and the same `unicode-range` split as Google Fonts, so a page with only ASCII text downloads just the latin files.

Source: Google Fonts, Judson v20, downloaded 2026-10-01 from `fonts.gstatic.com`; the licence comes from the google/fonts repository (`ofl/judson/OFL.txt`). The licence requires its copyright notice to travel with the fonts, so `OFL.txt` must stay next to them, unmodified.

Lobster and Charm are no longer used by the redesign; their remaining uses in legacy CSS go away as each owner converts its files.

## Primitives

File: `client/src/styles/sp/primitives.css`. It needs `tokens.css` and is class-based: the only bare selector is the focus ring.

- **Colour context.** Any element with `data-sp-color="White"` (or Blue, Green, Red, Brown, Gold) gets `--sp-color` (the gem colour) and `--sp-color-ink` (its numeral ink). Pips and gems use them, and any package can use them for borders, badges or text.
- **Buttons.** `.sp-btn` is at least 44x44px, 16px/600 text, padding `0 16px`, radius `--sp-r-2`. Variants: `.sp-btn-primary` (gold with gold ink), `.sp-btn-secondary` (surface 2 with a line border) and `.sp-btn-quiet` (transparent). `[aria-disabled="true"]` and `:disabled` drop to 45% opacity. Put the reason in a `.sp-reason` line (12px, muted) next to the button, not inside it, so it is not dimmed too.
- **Chips and badges.** `.sp-chip` (28px tall, surface 2, `--sp-r-1`) and `.sp-badge` (an 18px gold pill with dark numerals). A chip that is a control still needs a 44px hit box, which its package provides.
- **Pips.** `<span class="sp-pip" data-sp-color="Red">3</span>`: a `--sp-pip` disc in the gem colour with 11px numerals in its ink.
- **Gems and icons.** `<svg class="sp-gem" data-sp-color="Red" aria-hidden="true"><use href="#sp-gem-Red"></use></svg>` draws a gem from the sprite at 1.25em in the gem colour; `.sp-icon` draws any other symbol at 24px in the current text colour.
- **Rings.** `.sp-ring-yes` (2px solid gold) and `.sp-ring-gold` (2px dashed gold) mark affordability. They are drawn inside the element's box (`outline-offset: -2px`) so neighbouring cards 4px apart never overlap. While an element has keyboard focus the focus ring replaces its affordability ring; the badge still carries the information.
- **Utilities.** `.sr-only` (visually hidden, still read by assistive tech; Tailwind generates a compatible `.sr-only` of its own), `.sp-ellipsis` (one line with an ellipsis, `min-width: 0` so it works inside flex and grid) and `.sp-num` (tabular numerals; the buttons, chips, badges and pips already have them).
- **Focus ring.** `:focus-visible` gets a 2px `--sp-focus` outline with a 2px offset, so it shows for keyboard users only.
- **Hover and press.** A slight brightening on hover, inside the hover media query only, and a slight darkening while pressed, which also works on touch.

The primitives deliberately do not style `body` (background, font, numerals). Board pages get that from WP-SHELL's `board-base.css` and the entry pages from WP-LOBBY.

## The sprite

File: `client/src/components/SpSprite.astro`, an inline SVG with one `<symbol>` per shape, about 5.5KB rendered (the budget is 8KB). Render `<SpSprite />` once per page, at the start of `<body>`, then reference symbols by id. Every symbol has a 24x24 viewBox and 2px strokes in `currentColor`.

- **Gems**, each with its own outline so colour is never the only cue: `sp-gem-White` (a rhombus), `sp-gem-Blue` (a square cut with corner facets), `sp-gem-Green` (an octagonal emerald cut), `sp-gem-Red` (a round brilliant with a four-point star of facets), `sp-gem-Brown` (a hexagon) and `sp-gem-Gold` (a coin with a filled star). Their bodies are a 30% tint of the colour, so they read on light and dark backgrounds. The game-over confetti reuses these symbols.
- **Icons**: `sp-i-menu`, `sp-i-history`, `sp-i-close`, `sp-i-eye`, `sp-i-crown`, `sp-i-lock`, `sp-i-check`, `sp-i-cascade`, `sp-i-satchel`, `sp-i-sacrifice` (a flame), `sp-i-noble` (a crowned bust), `sp-i-city` and `sp-i-offline`.

Icons are decorative (`aria-hidden="true"`); the control that contains one carries the accessible name.
