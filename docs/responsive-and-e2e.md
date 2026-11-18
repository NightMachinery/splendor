# Responsive board and E2E workflow

On a narrow screen the board, your inventory and opponents stack vertically.
The top bar shows whose turn it is. During a move, tap **View board** to read
the board and history, then **Return to action** to pick up the same choice.
The history drawer opens at a readable width and scrolls independently.

Tap a face-up development card or one of your reserved cards to inspect
its art, costs, bonuses and effects. Purchase, reserve and cascade choices
show the selected card's details before confirmation. Purchase details show
what remains after your gem bonuses when they reduce the printed cost.
Purchase confirmation starts with an exact payment when one is available.
Adjust the gem and gold counters to choose a different payment, or reset to
the suggestion. The purchase summary shows when payment will discard a
double-gold or bonus card.
When reserving at the ten-token limit, choose a gem to return to take the
available gold, or leave the gold in the bank. The reserve dialog says when
the bank is out of gold and the card can still be reserved.

The entry pages use the device's viewport. In the lobby, **Create Session**
opens a tap and keyboard accessible game picker. A new session is ready to
launch when a second player joins.

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

The layout checks (`client/tests/layout.spec.ts`) catch horizontal overflow
and turn controls obscured by the board. The real-stack lobby test creates,
joins and launches a room with one phone and one desktop seat. The rendered
suite watches complete two-player games in every variant, probes both seats on
their turns and saves screenshots at the start, mid-game and game over. Set
`E2E_UI_TURNS=all` to play token moves with desktop clicks and phone taps.

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
