# chrome-cdp — drive Chrome directly for Splendor

A dependency-free screenshot/probe helper for a running Splendor frontend. It talks
to a headful Chrome over the Chrome DevTools Protocol (CDP) on `:9222` using Node's
built-in `WebSocket` (Node >= 22). Use it when MCP browser tooling is flaky, for
responsive screenshots, and for quick DOM probes such as “is there horizontal
scroll on mobile?”.

## Prerequisites

- Chrome is already running with remote debugging enabled:
  `curl --noproxy '*' http://127.0.0.1:9222/json/version` returns JSON.
- Splendor dev frontend is running. The default origin is `http://localhost:3000`.
  Override with `SPLENDOR_ORIGIN=...` when using Caddy/self-host URLs.

## Examples

```bash
# Home page at mobile viewport
node skills/chrome-cdp/shot.mjs --vp=mobile --probe --out=/tmp/splendor-home.png

# Orient board for a real launched session
node skills/chrome-cdp/shot.mjs --session=123 --board=orient --user=player1 \
  --display='Player 1' --token=token-player1 --vp=mobile --probe \
  --out=/tmp/splendor-board-mobile.png

# Direct path works for any route
node skills/chrome-cdp/shot.mjs --path='/gameboard-cities/?sessionId=123' --vp=desktop --probe
```

Flags:

- `--path=/route` navigates to an exact app route.
- `--session=ID --board=orient|cities|tradingposts` builds a board route.
- `--user`, `--display`, `--token`, `--refresh` seed Splendor localStorage keys
  (`username`, `displayName`, `accessToken`, `refreshToken`) before navigation.
- `--vp=desktop|mobile` uses CDP emulation, not OS window resizing.
- `--probe` prints JSON with `hscroll`, viewport/document dimensions, board/card
  counts, visible modal IDs, and visible text.
- `--out=PATH` saves a PNG screenshot.

## Workflow

For full-stack visual checks, start the app with `./self_host.py dev-start` or an
E2E/dev equivalent, create and launch a real lobby session, then capture one
perspective at a time. Because Splendor identity lives in localStorage, this tool
sets identity before loading the board. For multiple simultaneous browser tabs,
use isolated browser contexts; for sequential screenshots this single-tab script
is enough.
