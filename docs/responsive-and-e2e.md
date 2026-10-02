# Responsive board and E2E workflow

The game board is responsive down to portrait-phone widths. Desktop keeps the
classic three-column feel; narrow screens stack the main board, the current
player inventory, and other players vertically. Mobile may scroll vertically, but
it should not create page-level horizontal scroll.

## CSS structure

- `client/src/styles/gameboard.css` owns shared board, inventory, token, noble,
  card, and mobile layout rules.
- `client/src/styles/modals.css` owns responsive modal sizing and touch-friendly
  controls.
- Expansion-specific styles in `cities/` and `trading-posts/` adapt side panels
  so cities/powers wrap under the main board on mobile.

Prefer preserving existing DOM selectors when changing layout: the animation and
modal scripts clone/query board nodes directly.

## Tests

All test suites, how to run them and the current list of known layout debt
are in [testing.md](testing.md). In short, from `client/`:

```bash
pnpm test                  # mocked suite, including the layout checks
pnpm run test:e2e:fake     # whole games on the real board, offline
E2E_INSTANCE=e2e pnpm run test:e2e   # the same against an isolated instance
```

The layout checks (`client/tests/layout.spec.ts`) fail on any element that
sticks out past the viewport and on modal controls covered by other
elements. Pages that fail today on phones are listed as known layout debt and
show up as expected failures; a responsive change that fixes one should
remove it from `KNOWN_DEBT`.

The rendered full games (`client/tests/e2e/rendered-game.spec.ts`) watch
every game from a 1280x800 desktop seat and an emulated phone seat (Pixel 7,
with touch) at the same time, and probe the phone board for the same two
problems every few turns. A finding there is also recorded as known layout
debt (an expected failure). The phone board passes both probes today, but it
is far from comfortable: the whole board is a long single column (a full-page
phone screenshot is over 3,000 device pixels tall), the history panel is a
narrow strip of wrapped words, and the turn modals are covered as described
in testing.md. Each run saves full-page screenshots of both seats at the
start, mid-game and game over (see testing.md for where they land).

## Browser visual probes

The `splendor-browser` skill (`.claude/skills/splendor-browser/`, linked for
Codex as `.agents/skills/splendor-browser`) replaces the old
`skills/chrome-cdp` helper. It launches its own private headless Chrome,
seeds players and games through the real APIs (`seed.mjs`), screenshots any
seat with real mobile emulation (`shot.mjs`) and reports layout problems
(`probe.mjs`). Point it at an isolated instance (`--instance=NAME`) or at the
fake stack (`node client/tests/fixtures/fake-stack.mjs --web-port 0 --dist
client/dist`, see [testing.md](testing.md)), never at production or the
default instance. Its `SKILL.md` has the commands and options.
