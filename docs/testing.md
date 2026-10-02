# Testing

Everything here runs from `client/` with pnpm. Four suites cover different
layers:

- **Unit tests** (`client/tests/unit/*.test.mjs`, `node:test`): the bot, the
  rule checks, the offline rules mirror, the REST client and the fake stack.
  No browser, no server, a few seconds.
- **Mocked suite** (`client/tests/*.spec.ts`, Playwright projects
  `mocked-*`): the real client in a browser, served by `astro dev`, with the
  Lobby Service (LS) and Game Service (GS) replaced by `page.route` stubs.
  Checks login, lobby, every board and modal, the request bodies the client
  sends, and the layout on desktop and phones.
- **Full-stack API suite** (`client/tests/e2e/*.api.spec.ts`, project
  `e2e-api`): bots play whole games over HTTP against a running stack, for
  every game version and player count, and probe the rules with illegal
  moves. No browser.
- **Rendered games** (`client/tests/e2e/*.spec.ts` without `.api`, projects
  `e2e-desktop-chromium`, `e2e-mobile-chromium`, `e2e-mobile-webkit`): a whole
  bot game watched through the real board in a browser.

The two full-stack suites run against either a real stack (an isolated
self-host instance) or the **fake stack**, an offline stand-in for the LS and
GS described below. Without either, every full-stack test skips.

## Quick start

```bash
cd client
pnpm install
pnpm exec playwright install chromium webkit

pnpm run test:unit          # node:test unit tests
pnpm test                   # mocked suite (starts astro dev on 127.0.0.1:4329)
pnpm run test:e2e:fake      # full-stack suites, offline, on the fake stack
pnpm run lint:css           # the CSS lint (client/tools/lint-css.mjs)
```

Against a real stack (see "Running against a real stack"):

```bash
./self_host.py instance-start e2e          # from the repository root
cd client
E2E_INSTANCE=e2e pnpm run test:e2e:api     # whole games and rule probes
E2E_INSTANCE=e2e pnpm run test:e2e:ui      # rendered games
E2E_INSTANCE=e2e pnpm run test:e2e         # both
cd .. && ./self_host.py instance-stop e2e
```

The scripts in `client/package.json`:

- `test`: the mocked projects.
- `test:unit`: `node --test` over `tests/unit/**/*.test.mjs`.
- `test:unit:sp`: only the unit tests of the redesign's pure rule modules
  (`tests/unit/sp-*.test.mjs`, for `client/src/scripts/sp/`).
- `test:e2e`: every `e2e-*` project.
- `test:e2e:api`: `e2e-api` only.
- `test:e2e:ui`: the rendered-game projects (`e2e-*-*`).
- `test:e2e:fake`, `test:e2e:fake:api`: the same with `E2E_FAKE_STACK=1`.
- `test:sp`: the redesign's Playwright specs (`tests/sp-*.spec.ts`) on
  `mocked-desktop-chromium`. None exist yet, so it passes with no tests
  (`--pass-with-no-tests`).
- `test:all`: unit tests, then the mocked suite.
- `lint:css`: the CSS lint for iOS-safe syntax and the redesign's tokens
  (`node tools/lint-css.mjs`; see [ui/foundations.md](ui/foundations.md)).
  Legacy files are allowlisted in `tools/lint-css.allow.json`.
- `lint:css:self-test`: the lint's own fixtures (`--self-test`).
- `check:assets`: `python3 art/build-assets.py --check`, which fails when a
  generated icon or background is out of date. Needs Pillow.

Extra arguments go straight to Playwright, for example `pnpm test
tests/game.spec.ts` or `pnpm run test:e2e:fake --headed`. A script already
selects its projects, and a second `--project` adds to that selection instead
of narrowing it; for a single project call Playwright directly, as in `pnpm
exec playwright test --project=mocked-desktop-chromium tests/game.spec.ts`.

## The mocked suite

The Playwright config starts `pnpm exec astro dev --host 127.0.0.1 --port
4329` (change the port with `PW_MOCK_PORT`). Locally it reuses a server that
already listens there; set `PW_SKIP_WEBSERVER=1` to manage it yourself. Only
mocked runs start it: a run that selects only `e2e-*` projects does not.

Projects:

- `mocked-desktop-chromium`: Desktop Chrome, 1280x720.
- `mocked-mobile-chromium`: Pixel 7.
- `mocked-mobile-webkit`: iPhone 14. Off by default on macOS older than 15,
  see "WebKit on macOS 14".

The stubs live in `client/tests/util/`:

- `backend-mock.ts` is one `page.route` per page for `/ls/**` and `/gs/**`.
  It records every request and every player action, and answers the state
  long-poll the way the GS does: a request whose `hash` equals the MD5 of
  the current body is held for 1.5 s and then answered 204.
- `game.ts` builds game states in the exact shape the GS serializes, from the
  real card catalogue (`tests/fixtures/cards.mjs`, parsed from the server's
  CSV files).
- `ls-mock.ts` and `server-mock.ts` are shortcuts for the common setups.

The board exposes its progress on `<body>` so tests wait for facts instead of
sleeping: `data-splendor-ready="1"` once a state is rendered,
`data-splendor-turn` (whose turn it is, empty at game over),
`data-splendor-state-hash` (the MD5 of the GS body it rendered) and
`data-splendor-game-over="1"`. The lobby sets `data-splendor-lobby-ready`.

### Layout checks and known layout debt

`tests/layout.spec.ts` checks every page and turn modal at the project's
viewport and at 360x740. Two probes (`tests/util/layout.ts`):

- **overflow**: any visible element whose box reaches past the left or right
  edge of the viewport. This catches what `scrollWidth` misses, such as a
  child of an `overflow: hidden` parent.
- **covered controls**: any button, counter or card in an open modal whose
  centre point belongs to another element, so a tap there lands elsewhere.

Some pages fail today on phones. The responsive redesign is a later phase, so
those page and viewport pairs are listed as **known layout debt** in
`KNOWN_DEBT` in `tests/layout.spec.ts`. They still run, and a failure there
becomes an **expected failure** (Playwright's `test.fail`, shown as a passed
expected-fail) with a `known-layout-debt` annotation. Any pair not on the list
must pass. When a pair starts passing, remove it from the list.
`PW_LAYOUT_STRICT=1` turns all of them back into hard failures.

The current known layout debt, as of the last run:

- Desktop: the lobby. The sessions table is about 1400 px wide in a 1280 px
  viewport.
- Phones (Pixel 7 and 360x740): the title page and the login page have no
  `<meta name="viewport">`, so phones render them 980 px wide and scale them
  down.
- Phones: the turn modals (your turn, take tokens, put back tokens, buy a
  card, payment, reserve a card). The board chrome (the player inventory, the
  other players, the top bar and the history) is stacked above `.modal`, so it
  covers the modal's buttons, counters and cards.
- Phones: the Orient modals in `tests/modals-orient.spec.ts` (choose a
  satchel colour, cascade, reserve a noble), and the real-click case in
  `tests/ui-turns.spec.ts`, for the same reason: a real tap hits the board
  chrome.
- WebKit: every result. Nobody has seen a WebKit run yet (see below), so a
  WebKit failure is recorded as debt rather than a red build.

The mobile boards themselves (Orient, Cities, Trading Posts) and the lobby on
phones pass the overflow check.

## The full-stack suites

Shared code in `client/tests/e2e/lib/`. The `.mjs` modules are plain ES
modules with no dependencies, so other tools (for example the Chrome CDP
skill in `skills/chrome-cdp`) can import them too:

- `stack.mjs`: which stack to talk to (see "Choosing a stack").
- `splendor-api.mjs`: `SplendorApi`, a REST client for both services:
  local-auth users, create, join and launch sessions, read the state (with
  the MD5 long-poll), send actions. Session ids are 63-bit numbers, so they
  stay strings. Access tokens are replaced by `***` in error messages.
- `rules.mjs`: the game constants and pure rule checks:
  `stateViolations` (token conservation, at most 10 tokens, at most 3
  reserved cards, bonuses and prestige that match the cards, no card in two
  places, valid turn counter), `initialStateViolations` (the deal for a
  version and player count) and `finalStateViolations` (the winners follow
  the official rule: most prestige among the players who reached the goal,
  then fewest development cards, otherwise shared).
- `bot.mjs`: `nextAction(state, player, {seed})`, a deterministic bot that
  only makes legal moves, including every follow-up (cascades, satchels,
  nobles, cities, Trading Posts powers); and `playGame({api, players,
  version, seed, ...})`, which plays a whole game, re-reads the state after
  every action, checks `stateViolations`, checks that the turn passes to the
  next seat, and at the end checks equal turns and the winners. A violation
  throws a `BotError` carrying the state and the last 30 moves.
- `e2e.ts`: the Playwright `test` with an `api` fixture (skips without a
  stack, waits until both services answer), and the `E2E_*` knobs.
- `ui-actor.ts`: plays a seat's token turns by clicking through the take and
  put-back modals instead of calling the API.

Specs:

- `full-games.api.spec.ts`: one whole game per version and player count
  (4 versions times 2, 3 and 4 players). After the game, an action must be
  refused with 400, the actions endpoint must answer 200, and the LS must have
  deleted the session.
- `rules.api.spec.ts`: illegal moves must answer 400 (401 for another
  player's token) and leave the state byte for byte unchanged: gold taken like
  a gem, negative amounts, three of one colour, two plus one, four colours, a
  missing field, buying without paying or with tokens not held, an unknown
  card, reserving a noble, a follow-up that is not pending, moving out of
  turn, two from a pile of three, returning tokens while under ten, a fourth
  reservation, and overpaying.
- `rendered-game.spec.ts`: per version, a 2-player game with seat 0 logged in
  in the browser (its token and name are put in `localStorage` before the
  page loads). The bot plays both seats. After every turn the board's
  `data-splendor-state-hash` must equal the MD5 of the GS body, and
  `data-splendor-turn` must name the right player. On desktop, seat 0's token
  turns go through the modals (`E2E_UI_TURNS`). Every `E2E_LAYOUT_EVERY`
  turns the layout probes run and their findings become `layout`
  annotations, not failures. At the end the game-over modal must name every
  winner (by username).

Every game attaches `moves.log`; a failed one also attaches `state.json`,
`state-before.json` and a screenshot.

### Choosing a stack

`stack.mjs` resolves the target from the environment. An explicit URL wins
over the instance file, field by field:

- `E2E_INSTANCE=NAME` reads `.self-host/instances/NAME/instance.json`, which
  `./self_host.py instance-start NAME` writes. It supplies `baseUrl` (the web
  front, which proxies `/ls` and `/gs`), `lsUrl` and `gsUrl` (the services
  directly).
- `E2E_BASE_URL`: the web front. `E2E_LS_URL` and `E2E_GS_URL` default to
  `E2E_BASE_URL/ls` and `E2E_BASE_URL/gs`.
- `E2E_LS_URL`, `E2E_GS_URL`: enough on their own for the API suite. The
  rendered games also need a base URL and skip without one.
- `E2E_SELF_HOST_DIR`: where to look for `instances/` instead of the
  repository's `.self-host`.

The tests create users and sessions, so a host that is not a loopback address
is refused unless `E2E_ALLOW_REMOTE=1` is set. Never point them at the
production deployment.

### Running against a real stack

Start an isolated instance from the repository root (see
[self-hosting.md](self-hosting.md), "Isolated instances"):

```bash
./self_host.py instance-start e2e             # static build behind a private Caddy
./self_host.py instance-start e2e --mode dev  # or astro dev, for client work
```

Then run with `E2E_INSTANCE=e2e`, and stop it with `./self_host.py
instance-stop e2e` when you are done. An instance keeps its data across
restarts, so users from earlier runs accumulate; delete
`.self-host/instances/e2e` to start clean.

A static instance is the more reliable target for rendered games: an
`astro dev` front restarts itself (and the page loses its server) when files
under `client/` change mid-run, see "Troubleshooting".

### The fake stack (offline)

`E2E_FAKE_STACK=1` (`pnpm run test:e2e:fake`) runs the full-stack suites with
no Java, no Caddy and no instance. Playwright then:

1. builds the client with `astro build` into
   `client/node_modules/.cache/e2e-fake-dist` (skip this with
   `E2E_FAKE_SKIP_BUILD=1` to reuse the last build);
2. starts `node tests/fixtures/fake-stack.mjs`, which serves the fake LS on
   127.0.0.1:4331, the fake GS on 4332, and the build on 4330 with `/ls` and
   `/gs` routed to them (`E2E_FAKE_LS_PORT`, `E2E_FAKE_GS_PORT`,
   `E2E_FAKE_WEB_PORT` change the ports);
3. points `E2E_BASE_URL`, `E2E_LS_URL` and `E2E_GS_URL` at it. Setting
   `E2E_INSTANCE` or other URLs at the same time is an error.

The fake services speak the subset of the real APIs that the client and
`splendor-api.mjs` use (local-auth, sessions, launch, the MD5 long-polls,
actions with the same 400 and 401 answers, the session removed at game over).
The rules come from `tests/fixtures/engine.mjs`, an offline copy of the
server's rules.

What a fake-stack run proves: the client, the bot, the rule checks and the
specs agree with each other, and the client renders whole games correctly.
What it does not prove: that the real server follows the rules. The engine is
a copy of the server's rules as they were when it was written, so only a run
against a real instance checks the server.

The fake stack also works on its own, for example for the CDP skill:

```bash
node tests/fixtures/fake-stack.mjs --web-port 4340 --dist node_modules/.cache/e2e-fake-dist --verbose
```

It prints its URLs as JSON and serves until it gets SIGINT or SIGTERM.

## Environment variables

Stack selection:

- `E2E_INSTANCE`, `E2E_BASE_URL`, `E2E_LS_URL`, `E2E_GS_URL`,
  `E2E_SELF_HOST_DIR`, `E2E_ALLOW_REMOTE`: see "Choosing a stack".
- `E2E_FAKE_STACK=1`, `E2E_FAKE_SKIP_BUILD=1`, `E2E_FAKE_WEB_PORT`,
  `E2E_FAKE_LS_PORT`, `E2E_FAKE_GS_PORT`: see "The fake stack".

Full-stack knobs:

- `E2E_SEED` (default 1): every game derives its own seed from it, so a run
  is reproducible and different games still differ. The seed of each game is
  in its `game` annotation.
- `E2E_VERSIONS` (default all four): comma-separated, from `BASE_ORIENT`,
  `BASE_ORIENT_CITIES`, `BASE_ORIENT_CITIES_NOBLES`,
  `BASE_ORIENT_TRADE_ROUTES`.
- `E2E_PLAYERS` (default `2,3,4`): player counts for the API games.
- `E2E_UI_TURNS` (default `desktop`): which rendered-game projects play the
  browser seat's token turns through the modals. `desktop` only on desktop,
  `all` on every project with real clicks (expected to fail on phones while
  the turn modals are covered, see the known layout debt), `force` on every project
  with clicks dispatched straight to the controls (checks the request bodies
  despite the covered layout), `off` never.
- `E2E_LAYOUT_EVERY` (default 10): run the layout probes every N turns of a
  rendered game; 0 turns them off.

Playwright and the mocked suite:

- `PW_WEBKIT`: `1` forces the WebKit projects on, `0` forces them off.
- `PW_MOCK_PORT` (default 4329): port of the mocked suite's dev server.
- `PW_SKIP_WEBSERVER=1`: start no server at all.
- `PW_LAYOUT_STRICT=1`: known layout debt fails like any other check.
- `PLAYWRIGHT_HTML_OUTPUT_DIR`: where the HTML report goes (Playwright's own
  variable; CI gives each run its own folder).

## WebKit on macOS 14

Playwright 1.63 ships only a frozen WebKit build for macOS 14, and on macOS
14.3 it dies on launch with "Bus error: 10". So the WebKit projects are off by
default on macOS older than 15 (Darwin older than 24). On Linux and on newer
macOS they run. Until someone has looked at a WebKit run, CI runs the mocked
WebKit project as an informational step that cannot fail the job, and
`tests/layout.spec.ts` counts every WebKit layout failure as known debt.

Playwright's WebKit approximates Safari's engine; it is not iOS Safari.

## CI

`.github/workflows/playwright.yml` runs on changes under `client/`: pnpm
install, Chromium and WebKit, then the unit tests, the mocked suite and the
fake-stack suites on Chromium, then the mocked WebKit project as an
informational step. Each Playwright run writes its own folder under
`client/playwright-report/` and `client/test-results/`, and all of them are
uploaded as the `playwright-report` artifact. Nothing in CI talks to a real
LS or GS. `.github/workflows/build-backend.yml` builds and tests the server
with Maven.

## Troubleshooting

- **A rendered game fails at a random turn with the state hash `null`**, and
  the trace shows `ERR_CONNECTION_REFUSED` and a page error about
  `localStorage`: the web front went away mid-game. With `astro dev` this
  happens when the dev server restarts ("Configuration removed.
  Restarting..." in its log), which file events under `client/` can trigger
  while another session works there. The Vite client then reloads the page
  while the server is down. Use a static front: the fake stack always does,
  and so does `instance-start` without `--mode dev`.
- **"port already in use" when the fake stack starts**: the fake stack never
  reuses a running server, because a stale one holds old users and sessions.
  Stop the old process (by PID) or pick other ports.
- **Every full-stack test skipped**: no stack is configured. Set
  `E2E_INSTANCE` or the URLs, or use `pnpm run test:e2e:fake`.
- **A rule probe fails against a real instance but passes on the fake
  stack**: the server and `tests/fixtures/engine.mjs` disagree. Find out which
  one follows the rules in [game-rules.md](game-rules.md) and fix the other.
