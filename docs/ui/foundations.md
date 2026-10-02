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
- **The 3-4 player HUD heights resolve on `html` as well as on `body`.** The store writes `data-sp-players` on `body`, but `html` inherits from `:root`, not from `body`, and `html`-level rules such as `scroll-padding-top: var(--sp-hud-h)` read the token there. So `tokens.css` raises `--sp-hud-h` and `--sp-l-hud-h` on the root element in two ways: `:root:has(> body[data-sp-players="3"])` (and `="4"`), which needs nothing else where `:has()` works, and `html[data-sp-players]`, a mirror the store sets next to the body attribute for browsers without `:has()` (Safari before 15.4, Firefox before 121). The `:has()` rule stands alone because a browser that does not know `:has()` drops every selector in a list that contains it. `body[data-sp-players]` is kept as a last fallback, so the board regions get the right height even with neither. On T, D and W each of these selectors is reset to 56px by a later rule of the same specificity.
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

- **Board backdrop.** `.sp-board-backdrop` on `body` (or a page wrapper) draws the textured blue table as a fixed `::before` layer at `--z-backdrop`, the replacement for `background-attachment: fixed`. It declares a plain `url()` JPEG first and an `image-set()` with `type()` second, so browsers that cannot parse the second keep the first. Chromium picks `board-1280.avif` at 1x, `board-1920.avif` at 2x and up, and `board-1920.avif` on W. Set the page colour on `html` or on `body`, never on both: a `body` background that does not propagate to the canvas paints over negative z-index layers and hides the backdrop.

The primitives deliberately do not style `body` (background, font, numerals). Board pages get that from WP-SHELL's `board-base.css` and the entry pages from WP-LOBBY.

## The sprite

File: `client/src/components/SpSprite.astro`, an inline SVG with one `<symbol>` per shape, about 5.5KB rendered (the budget is 8KB). Render `<SpSprite />` once per page, at the start of `<body>`, then reference symbols by id. Every symbol has a 24x24 viewBox and 2px strokes in `currentColor`.

- **Gems**, each with its own outline so colour is never the only cue: `sp-gem-White` (a rhombus), `sp-gem-Blue` (a square cut with corner facets), `sp-gem-Green` (an octagonal emerald cut), `sp-gem-Red` (a round brilliant with a four-point star of facets), `sp-gem-Brown` (a hexagon) and `sp-gem-Gold` (a coin with a filled star). Their bodies are a 30% tint of the colour, so they read on light and dark backgrounds. The game-over confetti reuses these symbols.
- **Icons**: `sp-i-menu`, `sp-i-history`, `sp-i-close`, `sp-i-eye`, `sp-i-crown`, `sp-i-lock`, `sp-i-check`, `sp-i-cascade`, `sp-i-satchel`, `sp-i-sacrifice` (a flame), `sp-i-noble` (a crowned bust), `sp-i-city` and `sp-i-offline`.

Icons are decorative (`aria-hidden="true"`); the control that contains one carries the accessible name.

## The shared head

File: `client/src/components/BaseHead.astro`. The title, login, lobby and board pages render it inside their `<head>`; settings and the admin zone are out of scope and may adopt it later.

```astro
<head>
    <BaseHead title="Splendor | Login" />
    <!-- page-specific tags -->
</head>
```

It renders, in order: `<meta charset>`, the viewport `width=device-width, initial-scale=1, viewport-fit=cover`, `theme-color` #0b1422, the `<title>` (default "Splendor"), the 32px and 48px PNG favicons, the 180px `apple-touch-icon`, and the link to `/manifest.webmanifest`. It also imports `tokens.css` and `primitives.css`, so any page that uses it gets the tokens, the Judson faces and the focus ring without importing them again.

Props:

- `title`: the document title. On the board WP-HUD rewrites `document.title` on each turn.
- `preloadDisplayFont`: preloads the Judson 700 latin file. Set it only on pages that show a Judson title above the fold (login, lobby header, game over), because an unused preload wastes bandwidth and makes Chrome log a warning.

The two favicon links carry `data-sp-icon` (32 or 48) and `data-sp-turn-href`, the URL of the matching turn favicon (`/images/icons/icon-turn-32.png` and `-48.png`). WP-HUD swaps each link's `href` to its `data-sp-turn-href` when your turn starts and back when it ends, so no script hard-codes the icon paths.

`viewport-fit=cover` lets the page draw under the notch and home indicator; the safe-area tokens are how a region keeps its content out of them.

### The web manifest

File: `client/public/manifest.webmanifest`, hand-written JSON: name and short name "Splendor", `start_url` `/lobby/`, `scope` `/`, `display` standalone, `orientation` any, `background_color` and `theme_color` #0b1422, a description, and four icons: `icon-192.png` and `icon-512.png` with purpose "any", and `maskable-192.png` and `maskable-512.png` with purpose "maskable".

## The CSS lint

File: `client/tools/lint-css.mjs`, plain Node with no dependencies. Run it from `client/`:

- `node tools/lint-css.mjs` lints everything under `src/` and `public/`: CSS files, the `<style>` blocks of `.astro` and `.html` files, static `style="..."` attributes, and viewport metas. It exits 1 if anything outside the allowlist breaks a rule.
- `node tools/lint-css.mjs FILE...` lints only the named files.
- `--self-test` runs every rule against built-in fixtures and also checks the real `tokens.css` contrast. It exits 1 if any fixture is flagged differently than expected.
- `--contrast` prints the contrast probe (see below).
- `--summary` adds per-file counts, including findings the allowlist suppresses, which is the quickest way to see what a legacy file still has to fix.
- `--rules` lists the rules. `--verbose` prints the suppressed findings too. `--strict` turns stale allowlist entries into errors.

The intended package scripts are `"lint:css": "node tools/lint-css.mjs"` and a `--self-test` run in CI; until they land in `package.json`, call the script directly.

### Rules

Each rule enforces part of section 4 of the UX spec, with the id that findings print:

- `media-range`: no range syntax such as `(width <= 700px)` (iOS Safari before 16.4 ignores the whole block).
- `media-contract`: a query that uses orientation, height, hover, pointer, reduced motion or aspect ratio must be one of the section 0 strings exactly, and a width-only query at a layout threshold (700, 1024 or 1600px, give or take 1px) is rejected because it is a layout class missing its height condition. Other width switches, such as `(min-width: 400px)`, and `print` are fine.
- `at-layer`: no `@layer` and no `@import ... layer()`.
- `nesting`: no nested rules, no `&` and no `@nest`.
- `color-mix`: no `color-mix()`.
- `z-index`: a `z-index` is `var(--z-*)`, `auto` or a global keyword. A `calc()` offset from a token is a raw number too: add a rung to the ladder instead.
- `viewport-height`: no `100vh`, `100dvh`, `100svh` or `100lvh`; use `var(--sp-vh)`.
- `safe-area`: no `env(safe-area-inset-*)`; use `var(--sp-safe-t)` and its siblings.
- `background-fixed`: no `background-attachment: fixed`, also not in the `background` shorthand. Draw a fixed `::before` layer instead.
- `root-overflow`: no `overflow-x: hidden` or `clip` on `html`, `:root` or `body`, nor the `overflow` shorthand with those values. The clip hides horizontal overflow from the layout probes.
- `fixed-ancestor`: `html`, `body`, `:root`, `#game-elements` (or `.game-elements`), `.board-container` and `#board` (or `.board`) never get `transform`, `translate`, `rotate`, `scale`, `filter`, `backdrop-filter`, `perspective`, `contain`, `will-change`, `container` or `content-visibility` with a value other than the neutral one. Any of those would make the element the containing block of the fixed bank inside it. The rule looks at the subject of the selector, so `body .board-tokens` and `body::before` are fine.
- `hover-media`: every `:hover` selector sits inside `@media (hover: hover) and (pointer: fine)`, so nothing depends on hover and touch screens never get stuck hover states.
- `font-family`: `font-family` and the `font` shorthand use `var(--sp-font-*)` (or a global keyword). Descriptors inside `@font-face` are exempt.
- `viewport-meta`: a viewport meta reads exactly `width=device-width, initial-scale=1, viewport-fit=cover`, and a page under `src/pages/` that has an `<html>` element has a viewport meta or renders `<BaseHead />`.
- `contrast`: the required pairs of the contrast probe hold (only checked on `tokens.css`).
- `parse`: the CSS parses (balanced braces, closed comments and strings, no stray text).

`tokens.css` is exempt from `z-index`, `viewport-height` and `safe-area`, because it is where those raw values are meant to live.

### The allowlist

File: `client/tools/lint-css.allow.json`. It lists each legacy file that does not pass yet, its owner (the work package that converts or deletes it) and the rules it may still break. `"rules": "*"` is used only for the settings and admin zone pages and styles, which are permanently out of scope. When you convert a file, remove its entry (or the rules it no longer breaks) in the same commit. The lint prints a warning for an entry that no longer matches anything, such as a deleted file or a rule the file stopped breaking, and `--strict` fails on it.

When the lint was added, 24 legacy files broke 117 rule instances between them, so every entry starts with exactly the rules that file broke. A converted file is then held to every rule, and an unconverted one cannot pick up a new kind of violation unnoticed.

### The contrast probe

`node tools/lint-css.mjs --contrast` reads the colour tokens from the top-level `:root` rules of `tokens.css` (following `var()` references and blending `rgba()` over the background) and prints WCAG contrast ratios in two groups:

- **Required**, which fail the lint: every text token (`--sp-text`, `--sp-text-muted`, `--sp-gold`, `--sp-ok`, `--sp-warn`, `--sp-danger`) at 4.5:1 or more on `--sp-bg`, `--sp-surface-1` and `--sp-surface-2`; gold ink on gold (the primary button) and text on `--sp-final` (the final-round pill) at 4.5:1; and the focus ring at 3:1 on all three backgrounds. With the current values the lowest text pair is `--sp-danger` on `--sp-surface-2` at 5.05:1.
- **Advisory**, reported only: the numeral ink on each gem colour at 4.5:1, and each gem colour against `--sp-bg` and `--sp-surface-1` at the 3:1 non-text threshold.

Three advisory pairs fall short with the spec's palette: white numerals on Green are 3.41:1 (dark ink would give about 5.3:1), and Brown is 2.39:1 on `--sp-bg` and 2.10:1 on `--sp-surface-1`, so a brown gem outline is faint on the dark surfaces. The gem's own shape still identifies it, and its pile or pip carries the colour; the values follow the spec until its owner decides otherwise.

The probe's numbers were cross-checked in headless Chromium: all 18 required text pairs, resolved there through `getComputedStyle`, match the lint within 0.01.

## Assets

`client/art/build-assets.py` derives every served raster from its source; `client/art/README.md` lists the outputs and their provenance. It takes the targets `icons`, `turn-icons`, `title` and `boards` (all four by default) and `--check`, which exits 1 when an output is out of date. It is idempotent: each output is encoded in memory and written only when its bytes change, so a second run reports every file as unchanged and leaves git clean. The existing icons and title art came out byte-identical, so adding the new targets regenerated nothing that was already committed.

WP-FOUND added two targets:

- **Turn favicons**, `public/images/icons/icon-turn-32.png` and `icon-turn-48.png`: the normal 32px and 48px icons with a gold `--sp-gold` dot in a navy `--sp-bg` ring, flush with the top-right corner. The dot is 12px across with a 2px ring at 32px, and 18px with a 3px ring at 48px, drawn at 8x and box-downsampled so the edges are anti-aliased. Outside that corner the pixels are identical to the normal icon.
- **Board backgrounds**, `public/images/bg/`, from `public/images/bluebackground.jpg` (2500x1668, the original, kept as it is): `board-1280.avif` (1280x854, about 26KB), `board-1920.avif` (1920x1281, about 94KB) and the fallback `board-1280.jpg` (quality 78, about 95KB). AVIF replaces the WebP of the original plan because it is far smaller here; the JPEG is for browsers without AVIF or `image-set()` `type()`. `.sp-board-backdrop` serves them.

The existing assets were checked and left alone: every icon is the exact pixel size its name says, the apple-touch icon is opaque with the `#0b2a45` navy in its corners, and the maskable icons keep all artwork within the central 80% circle (the furthest artwork pixel is 76.4px from the centre of the 192px icon, against a 76.8px safe radius, and 202.8px against 204.8px at 512px).

## Verification

How each part was checked, so a later change can repeat it:

- The lint: `node tools/lint-css.mjs` passes over the whole tree, `--self-test` passes all fixtures (each forbidden pattern from the spec is flagged with exactly the expected rule, a clean fixture with every allowed form is not, and the exemptions for `tokens.css` hold), and disabling a rule in a copy of the script makes its fixtures fail.
- Player-count HUD heights: `tests/unit/sp-tokens.test.mjs` (part of `pnpm test:unit`; it skips itself when Playwright's Chromium is not installed) renders `tokens.css` in headless Chromium and reads `--sp-hud-h` and `--sp-l-hud-h` on `html` and on `body` for 2, 3 and 4 players at P, L, T, D and W, with the attribute on `body` only, on `html` only and on both. It repeats the check on a copy of the file with the `:has()` rules removed, as a browser without `:has()` sees it, and checks that `scrollIntoView()` under `html { scroll-padding-top: var(--sp-hud-h) }` leaves a target exactly below a 76px sticky HUD.
- Tokens, primitives, sprite and head: a scratch Astro page rendering `<BaseHead />`, `<SpSprite />` and every primitive was built and measured in headless Chromium at all target viewports. The card widths, HUD and dock heights, gutter, noble size, pip size, `--sp-vh` and the test insets came out as listed above; the 3-4 player HUD heights switch; both reduced-motion signals zero `--sp-motion` and cap durations at 120ms; both Judson weights load from `/fonts/judson/` with no external request; all 19 symbols exist with 24x24 viewBoxes and render; the focus ring is 2px `--sp-focus` with a 2px offset.
- Manifest: it parses as JSON, has every field from the spec, and each icon it names exists at the declared size.
