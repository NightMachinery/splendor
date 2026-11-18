# Responsive board and E2E workflow

On a narrow screen the board, your inventory and opponents stack vertically.
The top bar shows whose turn it is. During a move, tap **View board** to read
the board and history, then **Return to action** to pick up the same choice.
The history drawer scrolls independently and follows the latest turn until
you scroll back. New moves keep your place while you read earlier turns.
Select **Latest turn** to return to the newest entry and follow new moves again.
Turn headings and the winner message use the player display names from the
board, including when a display name update arrives during play.
Token changes show gem colors and counts next to the icons and wrap on phones.

Tap a face-up development card or one of your reserved cards to inspect
its art, costs, bonuses and effects. Purchase, reserve and cascade choices
show the selected card's details before confirmation. Purchase details show
what remains after your gem bonuses when they reduce the printed cost.
On phones up to 400 px wide, the deck backs sit above their card groups.
All six face-up market cards stay together with at least 44 px tap targets
at 320 px and wider.
Purchase confirmation starts with an exact payment when one is available.
Adjust the gem and gold counters to choose a different payment, or reset to
the suggestion. The purchase summary shows when payment will discard a
double-gold or bonus card.
When reserving at the ten-token limit, choose a gem to return to take the
available gold, or leave the gold in the bank. The reserve dialog says when
the bank is out of gold and the card can still be reserved.

The entry pages use the device's viewport. In the lobby, **Create Session**
opens a game picker you can use by touch or keyboard. Send guests the link from
**Copy invite link**. It highlights the matching session after sign-in, where
guests can select **Join**. The host sees how many more players are needed and
can select **Start game** as soon as a second player joins. Guests see when
they're waiting for the host. After the host
starts the game, both players select **Play** to enter. The lobby stacks room
details and actions vertically on phones, including when moderation is open.

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
