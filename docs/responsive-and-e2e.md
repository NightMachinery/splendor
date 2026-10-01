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

## Chrome CDP visual probes

A local CDP helper lives in `skills/chrome-cdp`. It can screenshot and probe a
running board without relying on browser MCP tools. Point it at an isolated
instance or at the fake stack (`node client/tests/fixtures/fake-stack.mjs
--web-port PORT --dist DIR`, see [testing.md](testing.md)), never at
production. The modules in `client/tests/e2e/lib/` (`splendor-api.mjs`,
`bot.mjs`, `stack.mjs`) can create the users and the game to look at:

```bash
node skills/chrome-cdp/shot.mjs --session=<id> --board=orient --user=<username> \
  --token=<access-token> --vp=mobile --probe --out=/tmp/splendor-mobile.png
```

The probe JSON includes `hscroll`, viewport/document dimensions, board/card
counts, visible modals, and visible body text.
