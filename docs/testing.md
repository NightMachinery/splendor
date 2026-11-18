# Testing

Everything here runs from `client/` with pnpm. Four suites cover different
layers:

- **Unit tests** (`client/tests/unit/*.test.mjs`, `node:test`): the bot, the
  rule checks, the offline rules mirror, the REST client, the fake stack
  and the pnpm commands of the CI workflows.
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
  `e2e-ui-chromium` and `e2e-ui-webkit`): a whole bot game watched by both
  players at once, one on a desktop browser and one on an emulated phone.

The two full-stack suites run against either a real stack (an isolated
self-host instance) or the **fake stack**, an offline stand-in for the LS and
GS described below. Without either, every full-stack test skips.

## Quick start

```bash
cd client
pnpm install
pnpm exec playwright install chromium webkit

pnpm run test:unit          # node:test unit tests, under 30 s
pnpm test                   # mocked suite (starts astro dev on 127.0.0.1:4329), 1.5 to 2 min
pnpm run test:e2e:fake      # full-stack suites, offline, on the fake stack, about 2 to 3 min
pnpm run lint:css           # the CSS lint (client/tools/lint-css.mjs)
```

Against a real stack (see "Running against a real stack"):

```bash
./self_host.py instance-start e2e          # from the repository root
cd client
E2E_INSTANCE=e2e pnpm run test:e2e:api     # whole games and rule probes, 10 to 25 s
E2E_INSTANCE=e2e pnpm run test:e2e:ui      # rendered games, about 2 to 3 min
E2E_INSTANCE=e2e pnpm run test:e2e         # both
cd .. && ./self_host.py instance-stop e2e
```

The times are from an Apple M2 laptop with Playwright's default worker
count, partly while other heavy jobs ran. The API suite plays its 24 games
in parallel, each in 1 to 4 s; each rendered game takes 1.5 to 2.5 min, and
the four run in parallel. On a busy machine the rendered games take longer;
see "Troubleshooting".

The scripts in `client/package.json`:

- `test`: the mocked projects.
- `test:unit`: `node --test` over `tests/unit/**/*.test.mjs`.
- `test:unit:sp`: only the unit tests of the redesign's pure rule modules
  (`tests/unit/sp-*.test.mjs`, for `client/src/scripts/sp/`).
- `test:e2e`: every `e2e-*` project.
- `test:e2e:api`: `e2e-api` only.
- `test:e2e:ui`: the rendered-game projects (`e2e-ui-*`).
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

Extra arguments go straight to Playwright, for example `pnpm run test
tests/game.spec.ts` or `pnpm run test:e2e:fake --headed`. Write `pnpm run
test`, not `pnpm test`, when passing options: pnpm 8 parses the options of
its built-in `pnpm test` itself and refuses `pnpm test --output=x` with
"Unknown options: 'output'". A script already
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

Chromium runs these checks on desktop, Pixel 7 and 360x740. The turn
modal tests also exercise real clicks. The suite treats unverified WebKit
geometry as expected debt. Set `PW_LAYOUT_STRICT=1` to require those
checks to pass as well.

## The full-stack suites

Shared code in `client/tests/e2e/lib/`. The `.mjs` modules are plain ES
modules with no dependencies, so other tools import them too (the
`splendor-browser` skill in `.claude/skills/splendor-browser/` seeds its games
with `splendor-api.mjs` and `bot.mjs`):

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
  next seat, checks after every round that the game ended if a player had
  reached the goal (15 prestige, or a city in the Cities versions), and at
  the end checks equal turns and the winners. A violation throws a
  `BotError` carrying the state and the last 30 moves. The node:test suite
  feeds it deliberately broken engines (wrong winner, tokens created, the
  game ending a round late) to show each check fires.
- `e2e.ts`: the Playwright `test` with an `api` fixture (skips without a
  stack, waits until both services answer), and the `E2E_*` knobs.
- `ui-actor.ts`: plays a seat's token turns by clicking through the take and
  put-back modals instead of calling the API.

Specs:

- `full-games.api.spec.ts`: `E2E_SEEDS` whole games (default 2, each with its
  own seed) per version and player count, so 24 games by default (4
  versions times 2, 3 and 4 players times 2). After the game, an action by
  every player must be refused with 400, the actions endpoint must answer
  200 `[]` for every player (never 500), the state must not have changed,
  and the LS must have deleted the session. Each test attaches a
  `game.json` (seed, the cards dealt face up, rounds, turns, actions,
  winners, prestige, time).
- `rules.api.spec.ts`: illegal moves must answer 400 (401 for another
  player's token) and leave the state byte for byte unchanged: gold taken like
  a gem, negative amounts, three of one colour, two plus one, four colours, a
  missing field, buying without paying or with tokens not held, an unknown
  card, reserving a noble, a follow-up that is not pending, moving out of
  turn, two from a pile of three, returning tokens while under ten, a fourth
  reservation, and overpaying. Probes that need a particular moment watch
  whole bot games and fire when it comes: a wrong-tier, owned or unknown
  card for a pending cascade, main actions and the next player's moves while
  a follow-up is pending, a Satchel turned into Gold, and overpaying with
  gold to spare. About 45 illegal moves in all.
- `rendered-game.spec.ts`: per version, a whole 2-player game watched by
  both players at once, in two browser contexts: seat 1 on a desktop
  (1280x800) and seat 2 on an emulated phone with touch (Pixel 7 in
  Chromium, iPhone 14 in WebKit). Each seat's token and name are put in
  `localStorage` before the board loads. The bot plays every move over the
  API, so the turn UI (about to be redesigned) is only rendered, not driven,
  unless `E2E_UI_TURNS` says otherwise. Checked on the way:
  - after every action both boards render exactly the served state:
    `data-splendor-state-hash` equals the MD5 of the GS body and
    `data-splendor-turn` names the player to move;
  - every `E2E_DOM_EVERY` turns, and at the start and the end, both boards
    show the bank, every player's prestige, the nobles, the cities and the
    card ids of every tier row as the API state has them;
  - in three idle windows (start, mid-game, game over) of `E2E_IDLE_MS`
    each, no seat sends more than 3 game-state GETs, and at the start and
    mid-game each seat still has a long-poll open (or sent one), so a board
    that busy-loops or one that stopped polling both fail. The real GS holds
    a poll for up to 30 s, so there a healthy seat sends none (the fake stack
    holds polls for a shorter time, so one per window is normal there);
  - no page error and no console error on either seat. The one exception is
    the board's LS session poll failing (406, then 400) once the LS has
    deleted the finished session;
  - at the end both seats show the game-over modal, "VICTORY" only for the
    winners and "GAME OVER" for everyone else, the modal names every winner
    by display name, and the LS has deleted the session;
  - on its first turn and about every `E2E_LAYOUT_EVERY` turns after
    that, each seat has an open turn modal with reachable controls and no
    horizontal overflow. Failures attach `layout.json`. The
    `layout-probes` annotation lists the turns checked;
  - the opponent panel shows each badge and moderation button once.

  Full-page screenshots of both seats at the start (the desktop seat's
  turn), at the first phone turn from turn `E2E_MID_TURN` on (so the phone's
  own turn modal is in the picture) and at game over are saved in the test's
  output folder
  (`test-results/<test>/desktop-start.png`, `mobile-start.png`,
  `desktop-mid.png`, `mobile-mid.png`, `desktop-game-over.png`,
  `mobile-game-over.png`), attached to the HTML report, and listed in a
  `screenshots` annotation. They check nothing: a capture that times out is
  noted in a `screenshot-failed` annotation and does not fail the game.

- `tests/e2e/two-player-lobby.spec.ts` starts with two fresh browser sessions.
  The phone host creates an Orient room and launches it as soon as the
  desktop guest joins. Both enter the board and take one turn through the
  dialogs. The test checks that each seat sees one opponent and that the
  server started with four tokens per ordinary color.

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

`instance-start` never builds the jars. It copies `server/target/splendorGame.jar`
and `setup/LobbyService/target/ls.jar` into the instance when it starts, so
after a server change rebuild them and run `instance-start` again (it
restarts a running instance):

```bash
mvn -f server/pom.xml -DskipTests -Dmaven.javadoc.skip=true -Dpmd.skip=true -Dcheckstyle.skip=true package
mvn -f setup/LobbyService/pom.xml -Psqlite -DskipTests -Dmaven.javadoc.skip=true -Dpmd.skip=true package
```

In static mode it also rebuilds `client/dist` when a client source is newer
than it. The test runs never touch the default instance or production.

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

Deals are reproducible. A session created with the header
`X-E2E-Deal-Seed: N` (which `SplendorApi.createGame` sends when given a
`dealSeed`, and `playGame` and the rendered games always give it) is dealt
from N alone. Any other session is dealt from the stack's `--seed` and the
order in which sessions were created, which depends on how parallel workers
were scheduled. The real LS ignores the header.

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

- `E2E_SEED` (default 1): every game derives its own seed from it, so
  different games differ. The seed of each game is in its `game`
  annotation. What it fixes depends on the stack:
  - the bot's choice for a given state, everywhere. Player names do not
    count, only seats, so fresh users in a rerun do not change the moves;
  - on the fake stack, also the deal: `createGame` sends the seed as the
    `X-E2E-Deal-Seed` header and the fake LS deals that game from it. A
    rerun with the same `E2E_SEED` replays every game move for move,
    whatever else runs in parallel;
  - on a real stack, not the deal. The GS shuffles at random unless it was
    started with `gs.shuffleSeed` (every game then gets the same deal for a
    version and player count), and `self_host.py instance-start` does not
    set it. So a rerun there plays different games. To compare runs, look
    at the `deal` in each `game.json`; to debug a failed game, use the
    `state.json`, `state-before.json` and `moves.log` it attaches.
- `E2E_VERSIONS` (default all four): comma-separated, from `BASE_ORIENT`,
  `BASE_ORIENT_CITIES`, `BASE_ORIENT_CITIES_NOBLES`,
  `BASE_ORIENT_TRADE_ROUTES`.
- `E2E_PLAYERS` (default `2,3,4`): player counts for the API games.
- `E2E_SEEDS` (default 2): whole API games per version and player count.
- `E2E_UI_TURNS` (default `off`): which seats play token turns through the
  board. `desktop` uses desktop clicks, `all` uses desktop clicks and
  phone taps, and `force` dispatches clicks directly for diagnostics.
- `E2E_LAYOUT_EVERY` (default 10): in a rendered game, probe each seat's
  layout on its own turn about every N turns (see "Rendered games" above);
  0 turns the probes off.
- `E2E_DOM_EVERY` (default 5): compare both boards' DOM with the API state
  every N turns.
- `E2E_IDLE_MS` (default 5000): length of each idle window in which the
  game-state requests are counted.
- `E2E_MID_TURN` (default 24): the mid-game screenshots and idle window
  happen at the first turn from this one on at which the phone seat is to
  move (turn 25 in a 2-player game).

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

`tests/unit/ci-workflow.test.mjs` reads every workflow and fails on a pnpm
command that cannot run: `pnpm test` (or `start`) followed by options, which
pnpm refuses (see "Quick start"), and `pnpm run` of a script that
`client/package.json` does not define. A mocked-suite step written as `pnpm
test --output=...` once failed every CI run this way. The check is static: it
does not catch a wrong Playwright option or project name, so after changing a
step, run its command locally with `--list` added.

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
- **A rendered game fails with "the desktop (or mobile) board did not render
  the served state" and the trace shows the board's last game-state GET
  still pending**: the GS did not wake that long-poll. This was a real GS bug
  (simpoll's watcher missed a move made between its hash comparison and the
  start of its wait, so the board stayed on the old state until the 30 s
  timeout); `GameStateWatcher` fixes it, see
  [client-architecture.md](client-architecture.md), "Long polling". If it
  comes back, check that the instance runs a jar built after that fix:
  `instance-start` copies the jars when it starts.
- **Rendered games time out or screenshots are noted as `screenshot-failed`
  on a busy machine**: each rendered game drives two pages, and a full-page
  phone screenshot at device scale is large. Run fewer at once, for example
  `E2E_INSTANCE=e2e pnpm run test:e2e:ui --workers=2`.
- **A `[poll:board-lobby-session] network problem` warning about 50 s into a
  rendered game**: expected with the LS as it is. The LS ends an idle
  long-poll with 408 after 30 s, and Chromium does not hand a 408 on a reused
  connection to the page; it sends the request again. The page's fetch then
  runs into the board's 50 s abort. Warnings do not fail the rendered games
  (only errors do).
