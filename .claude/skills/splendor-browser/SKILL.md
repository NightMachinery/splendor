---
name: splendor-browser
description: Screenshot and inspect the Splendor web client in a private headless Chrome, as any player. Use to look at the game board, lobby or login page, check the mobile or responsive layout (phone, landscape, tablet, desktop with real touch emulation), view a game from player 1's or player 2's seat (or as a spectator), capture the game-over screen, or run visual QA and layout probes (overflow, clipped content, small tap targets, covered buttons, console and HTTP errors).
---

# splendor-browser

Dependency-free Node 24 scripts (built-in WebSocket and fetch) that drive
Chrome over the DevTools Protocol (CDP). Paths below are relative to this
skill's folder; run them from anywhere.

- `scripts/seed.mjs` creates players and a game through the real REST APIs,
  and can let the e2e bot play N turns or the whole game.
- `scripts/shot.mjs` takes screenshots (and probes) per perspective and
  viewport.
- `scripts/probe.mjs` runs the same capture without PNGs and prints a
  findings report.
- `scripts/brave.mjs` is an optional check in the user's real Brave.
- Library modules: `capture.mjs` (the shared driver, with every option listed
  in its header), `browser.mjs` (launch, contexts, emulation, cleanup),
  `cdp.mjs` (the CDP client), `inpage.mjs` (the readiness check and the
  probe that run inside the page), `util.mjs`.

## Prerequisites

- Node 24 (22 works), and Google Chrome at `/Applications/Google Chrome.app`
  (or `--chrome=PATH`, or `SPLENDOR_CHROME`).
- A stack to talk to. Two options:
  - An isolated self-host instance: `./self_host.py instance-start cdp`
    (rebuilds `client/dist` when sources changed), then pass
    `--instance=cdp`. Stop it with `./self_host.py instance-stop cdp`.
  - The offline fake stack (no Java; rules from the JS engine double, not the
    real server): `node client/tests/fixtures/fake-stack.mjs --web-port 0
    --dist client/dist` prints `{"baseUrl": ...}`; pass `--base-url=THAT`.
    Run it in tmux and kill the session afterwards.

## The origin rule

The browser must load the client from an origin that also proxies `/ls` and
`/gs`: an instance's `baseUrl` or the fake stack's `baseUrl`. A bare
`astro dev` port has no backend, so the client drops the identity and
redirects to `/login/`. Never point any of this at the production site or at
the default instance (`splendor-lobby`, `splendor-game`, ...). The scripts
refuse non-loopback origins unless `--allow-remote` is given, and seeding
against production would create real users.

## Quick start

```bash
SK=.claude/skills/splendor-browser/scripts
OUT=<your scratch dir>
node $SK/seed.mjs --instance=cdp --version=orient --players=2 --advance=10 --out=$OUT/ids.json
node $SK/shot.mjs  --identities=$OUT/ids.json --as=p1,p2 --vp=phone,landscape,desktop --out-dir=$OUT/mid
node $SK/probe.mjs --identities=$OUT/ids.json --as=p1,p2,spectator --vp=se,phone,landscape,tablet --assert=all --out-dir=$OUT/probe
node $SK/seed.mjs --from=$OUT/ids.json --to-end          # the bot finishes the game
node $SK/shot.mjs  --identities=$OUT/ids.json --as=all --vp=phone,desktop --out-dir=$OUT/end
```

Then look at the PNGs with the Read tool. Always pass `--out-dir` (and
`--out` to seed.mjs) under your scratch directory; the default is
`$TMPDIR/splendor-browser/`.

`seed.mjs` options: `--version=orient|cities|cities-nobles|tradingposts`
(or the enum name), `--players=2..4`, `--names=a,b`, `--advance=N`,
`--to-end`, `--seed=N`, `--no-launch` (session left in the lobby),
`--no-session`, `--no-spectator`, `--from=FILE` to continue a game. Display
names get a `cdp-` prefix; the identities file (tokens included) is written
0600 and tokens are never printed or put on a command line. Seeding and
`--to-end` each take a second or two on a local instance.

## Perspectives (`--as`)

- `p1`, `p2`, ...: the seated players, each in its own browser context (own
  localStorage). The identity (`displayName`, `accessToken`, `username`) is
  seeded with `Page.addScriptToEvaluateOnNewDocument` before any page
  script, after clearing the old keys, on the first document of the tab only.
- `spectator`: a logged-in user who is not seated. The inventory is hidden
  (`#player-inventory.hide`), and the probe reports `spectating`.
- `anon`: no identity. A board URL redirects to `/login/`, which the run
  reports as `REDIRECTED` and not ready.
- `all`: every identity in the file.

What the board shows:

- the player whose turn it is gets `#your-turn-modal` over the board
  (`--modals=close` hides it, `--modals=both` captures both);
- at the end every perspective gets `#gameover-modal` (VICTORY for the
  winner);
- after a game ends the Lobby Service forgets the session, so names fall back
  to usernames (`cdp_p1_2` instead of `cdp-p1`) and a 400 from
  `/ls/api/sessions/ID` is expected (the probe marks it as expected).

## Viewports (`--vp`, comma separated)

Presets (mobile ones get `mobile: true` metrics, touch emulation and a
mobile user agent): `se` 375x667, `phone` 390x844, `android` 360x800,
`landscape` 844x390, `tablet` 820x1180, all at DPR 2; `desktop` 1280x850
and `wide` 1920x1080 at DPR 1. Custom: `WxH[@dpr]` is a desktop viewport,
`WxH[@dpr],mobile` a touch one (`--vp=600x900,mobile,1000x700`). `--matrix`
runs every preset, `--dpr=N` overrides the ratio. `--insets` sets
`html[data-sp-test-insets]`, which fakes notch safe-area insets (47px left
and right, 21px bottom) for the `--sp-safe-*` tokens.

Other capture options: `--page=board|lobby|home|login|settings` or
`--path=/x`, `--full` (whole document), `--click=SELECTOR` (a real tap on
touch viewports, repeatable), `--eval=EXPR`, `--wait-for=EXPR`,
`--timeout=MS`, `--settle=MS`, `--jobs=N` (tabs in flight, default 3),
`--label`, `--json`, `--png` (probe.mjs only).

## Readiness

Before probing, each tab waits (default timeout 30 s) until all of these hold
for 700 ms: the load event, `document.fonts` loaded, `body[data-splendor-ready="1"]`
on boards (`data-splendor-lobby-ready` on the lobby), `#anime-overlay` empty, no
card image still `.invisible`, every image complete, and no finite CSS
animation or transition running. A timeout is recorded as NOT READY, not
fatal. A 6-shot run takes about 15 to 20 s.

## Reading the probe

Each shot line and the probe report give: whose turn it is (`mine` when it
is this perspective's), open modals, bank counts read from the counters,
visible board cards, nobles and cities, plus these findings:

- `ZOOMED OUT` (touch viewports): the layout is wider than the screen, so a
  phone shows the page shrunk. Usually a missing
  `width=device-width` viewport meta (980px layout) or content wider than
  the screen.
- `beyond`: elements past the left or right screen edge. `html`/`body`
  `overflow-x: hidden` does not excuse them, since that is exactly what hides
  real overflow on phones.
- `below`: elements ending below what the page can scroll to, or in a
  fixed layer taller than the screen.
- `clippedX` / `clippedY`: containers with overflow hidden that cut content
  off, with the culprits named.
- `small-taps`: controls under 44x44 CSS px (touch viewports only).
  Controls are native ones, ARIA roles, `on*` handlers, listeners seen
  through DevTools `getEventListeners`, or the outermost `cursor: pointer`.
- `covered`: controls whose 3x3 grid of hit-test points lands on another
  element. `IN MODAL` means a modal's own button is under something, which is
  a stacking bug.
- broken images, console errors and exceptions, HTTP responses of 400 or
  more and failed requests. The Lobby Service's 408 long-poll timeout is
  marked expected.

Intentional off-canvas parts are excluded: the closed menu, the parked page
transition curtain, the history drawer's peek, the other-player hover
panels, animation clones and toasts. `--assert=LIST` (`ready`,
`no-overflow`, `no-hscroll`, `no-unreachable`, `no-clipped`, `tap-targets`,
`not-covered`, `no-broken-images`, `no-console-errors`, `no-http-errors`, or
`all`) makes the exit code 1 when one fails; 2 means bad usage.

## Real Brave (optional)

`node scripts/brave.mjs --url=BASEURL/login/ --vp=phone` probes a page in the
user's running Brave through `/opt/homebrew/bin/brave-cli`. It opens exactly
one incognito window (`open URL -i`), never touches, lists or reads existing
tabs, never writes an identity, runs the probe inside a same-origin iframe of
the requested width, and closes only the tab it opened. It shows the
Hammerspoon screen banner while it runs. It needs "Allow JavaScript from
Apple Events" (View > Developer). When that is off it says so, closes its
window and exits 3. Never change that setting yourself; ask the user. It
cannot screenshot or emulate touch.

## Safety and cleanup

- The default browser is a throwaway headless Chrome:
  `--headless=new`, a fresh `--user-data-dir` named `splendor-browser-*`,
  `--remote-debugging-port=0` (read back from `DevToolsActivePort`), and no
  proxy for local origins. It never touches the user's browsers and needs no
  screen banner.
- Shutdown sends `Browser.close`, then stops what Chrome left running and
  deletes the profile. Leftovers are found two ways, both by explicit PID:
  a `ps` listing filtered in code on the literal `--user-data-dir` argument,
  and `lsof` on Chrome's private stderr file in the profile, which every
  process Chrome spawns inherits. The second catches `chrome_crashpad_handler`
  and `GoogleUpdater`, which macOS Chrome starts without the profile argument
  and which otherwise linger for minutes or days. Ctrl-C does the same. To
  double-check afterwards:
  `ps -axww -o pid=,command= | grep -F -- '--user-data-dir=' | grep -F splendor-browser-`.
- `--cdp=URL` attaches to a browser that already listens for CDP instead.
  Even then it only creates its own contexts and tabs and disposes them; it
  never closes that browser or touches its tabs. Do not use it with the
  user's everyday browser profile.
- Stop the instance you started (`./self_host.py instance-stop cdp`) and any
  fake stack, and confirm their ports are free.

## Extending

For a one-off check, import the library rather than writing a new CDP client:

```js
import { getBrowser, parseViewport } from "./scripts/browser.mjs";
const browser = await getBrowser({ noProxy: true });
try {
    const page = await browser.newPage(await browser.newContext());
    await page.emulate(parseViewport("phone"));
    await page.goto(`${baseUrl}/login/`);
    console.log(await page.evaluate("document.title"));
} finally { await browser.close(); }
```
