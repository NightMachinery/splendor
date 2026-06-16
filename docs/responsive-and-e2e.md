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

## Full-stack E2E

The mocked Playwright suite remains the default:

```bash
cd client
npm test
```

The live full-stack smoke suite is opt-in and expects real services to be
running. Start the app with the self-host dev workflow or equivalent, then run:

```bash
./self_host.py dev-start --url https://splendor.pinky.lilf.ir
cd client
E2E_FULL_STACK=1 E2E_BASE_URL=http://127.0.0.1:<printed-dev-port> npm run test:e2e
```

The full-stack test creates local-auth users, creates/joins/launches a real
Lobby Service session, performs real Game Service actions, and checks the board
at desktop and mobile viewports. Use `E2E_LS_URL` and `E2E_GS_URL` to bypass a
frontend proxy when needed.

## Chrome CDP visual probes

A local CDP helper lives in `skills/chrome-cdp`. It can screenshot and probe a
running board without relying on browser MCP tools:

```bash
node skills/chrome-cdp/shot.mjs --session=<id> --board=orient --user=<username> \
  --token=<access-token> --vp=mobile --probe --out=/tmp/splendor-mobile.png
```

The probe JSON includes `hscroll`, viewport/document dimensions, board/card
counts, visible modals, and visible body text.
