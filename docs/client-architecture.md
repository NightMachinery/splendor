# Client architecture

This note describes how the web client in `client/` is put together: which page loads which script, how a browser identifies its player, how the pages stay up to date through long polling, and which DOM attributes end-to-end tests can rely on.

The client is an Astro 2 site built to static files. Pages are mostly plain HTML with vanilla JS modules from `client/src/scripts/`, plus a few React islands (toasts, History). Every request goes to the same origin: `${origin}/ls/...` for the Lobby Service (LS) and `${origin}/gs/...` for the Game Service (GS). Caddy strips those prefixes and forwards to the two Java services (see `self_host.py` and `docs/self-hosting.md`). `SETTINGS.getLS_API()` and `SETTINGS.getGS_API()` in `settings.js` build these base URLs.

## Page map

- `/` (`pages/index.astro`, `scripts/titleScreen.js`): the title screen. A browser without a stored display name is sent to `/login/`. Otherwise the button reads "Continue" and leads to the lobby.
- `/login/` (`pages/login.astro`, `scripts/login.js`): asks for a display name and registers it (see "Identity model"). A browser that already has an identity is sent back to `/`.
- `/lobby/` (`pages/lobby.astro`, `scripts/lobby.js`, `scripts/lobby-saves.js`): the Sessions tab long-polls the session list; the "Load a Game" tab lists saved games once per click. Create, join, leave, delete, launch and play live here.
- `/settings/` (`scripts/settings-page.js`) and `/adminzone/` (`scripts/adminzone.js`): account and admin pages.
- The three boards, chosen from the game version (see "Game versions"):
  - `/gameboard/` for `BASE_ORIENT`;
  - `/gameboard-cities/` for `BASE_ORIENT_CITIES` and `BASE_ORIENT_CITIES_NOBLES`;
  - `/gameboard-tradingposts/` for `BASE_ORIENT_TRADE_ROUTES`.

  Each board loads `game.js` (state polling and rendering) and `modals/modals.js` (the turn modals). The cities board adds `game-cities.js` and the trading-posts board adds `game-tradingposts.js`; both register extra renderers through `addUpdater` from `game.js`. A board URL carries `?sessionId=<id>`, and a migrate link adds `&migrate=<room token>`.

## Identity model

A player is identified by a random token that the browser generates itself. Login is passwordless.

Stored keys:

- `localStorage.displayName`: the name the player typed. Its presence is what `SETTINGS.hasLocalIdentity()` checks.
- `localStorage.accessToken`: 48 hex characters from `crypto.getRandomValues` (which works over plain http too). It is sent as `access_token` on authenticated requests.
- `localStorage.username`: the LS username, a slug of the display name chosen by the server (for example `alice_smith`, `player_2` for a name with no Latin letters).
- `sessionStorage["roomUser:<sessionId>:<migrate token>"]`: the username a migrate link stands for, kept per tab. While a page URL carries a `?migrate=` link that the LS has not rejected, `SETTINGS.getAccessToken()` returns the migrate token and `SETTINGS.getUsername()` returns this stored name.

`SETTINGS.verifyCredentials()` is the single identity check:

- With a migrate link it first asks `GET /ls/api/sessions/<id>/migrate/<token>`. A 200 stores the room user and finishes. A 5xx, a 429 or a network error is transient (see below). Any other reply (the LS answers 400 for an invalid or expired link, or for a user that no longer exists) rejects the link for the rest of the page load: `getAccessToken()` and `getUsername()` both return the local identity from then on, the `migrate` parameter is removed from the address bar with `history.replaceState`, `SETTINGS.migrateLinkRejected()` becomes true, and the check continues with local-auth below. The board then shows a toast saying the link is no longer valid. Before, the page took the local username but kept sending the dead room token, so every move was refused with a 401 ("Token does not match requested players name").
- Otherwise it posts `{token, displayName}` to `POST /ls/api/local-auth`. The LS returns the account for a known token, or creates one for an unknown token, and the client stores the returned `token`, `username` and `displayName`.
- Each identity request (local-auth or the migrate check) is aborted after 15 s (`IDENTITY_REQUEST_TIMEOUT_MS`), headers and body together, and the timeout counts as transient. Without it, one request stuck on a dead socket after a network switch, or on a stalled LS, kept the cached promise pending forever: the board never sent its first poll, no "Reconnecting..." appeared, and every action waited on the same promise.
- The result is cached for the page load. Later calls return the cached promise without a request, so the board and the lobby send one local-auth request per page load, not one per poll or per action. A failed check is not cached. `SETTINGS.invalidateCredentials()` drops the cache, and the lobby and the poll loop call it after a 401. Passing `force: true` or `allowCreate: true` always checks again. A `storage` event that changes one of the identity keys in another tab also drops the cache.

Identity safety: the stored identity is cleared only on a definitive rejection. That means a 401 or 403 from local-auth, or any 4xx whose JSON body is `{"error": "unknown_token"}` or `{"error": "invalid_token"}` (a contract the LS may adopt if it stops creating accounts for unknown tokens). In that case `verifyCredentials` clears the keys, sends the browser to `/login/` and throws an `AuthRejectedError` (`err.authRejected === true`). Every other failure (network error, 5xx such as Caddy's 502 during a redeploy, 429, 400, or a 200 that is not the expected JSON) throws a `TransientAuthError` (`err.transient === true`) and leaves every key in place. Before this rule, a single 502 replaced the player's account, which also lost their seats and saved-game ownership.

The login page passes the typed name as `verifyCredentials({allowCreate: true, displayName})`. The name is written to `localStorage` only after the LS accepted it; on failure the page shows an error toast and stays put. The generated token is stored before the request, so a retry after a lost reply maps to the same account.

## Long polling

### What the servers do

Both servers implement the same idea. A GET carries `hash=<x>`. If `x` equals the MD5 of the exact JSON string the server would send, the server holds the request until the content changes or a 30 s timeout expires; otherwise it answers at once with the JSON.

- GS, `GET /gs/api/sessions/<id>?hash=` (simpoll `ResultGenerator.getStringResult`). It compares against `DigestUtils.md5Hex(json)`, where `json` is the Gson string it returns. On timeout it answers 204 ("No update."). An unknown session gives 400. A completed watcher would give 410; the controller never completes one today. Each request waits through its own watcher from `GameStateWatcher.forOnePoll()`, which takes the change latch before the hash comparison. simpoll's own `ContentWatcher` waits on the latch that is current when its waiting thread starts, so a move that landed between the comparison and that moment went unseen until the 30 s timeout (the rendered e2e games caught a board stuck this way).
- LS, `GET /ls/api/sessions?hash=` and `GET /ls/api/sessions/<id>?hash=` (asyncrestlib `ResponseGenerator.getHashBasedUpdate`). It compares against `md5Hex(new Gson().toJson(content))`, which is also the body it sends. On timeout it answers 408. An unknown session gives 400. A request that is waiting when its session is deleted (the GS deletes it at game over) gets 406 Not Acceptable: asyncrestlib 1.5.1 hands Spring the unbuilt `ResponseEntity.noContent()` builder, which has no JSON form. The board's LS poll treats that as a server error, retries after a backoff, gets the 400 and stops.

Both endpoints declare `application/json; charset=utf-8`, and `md5Hex(String)` hashes the UTF-8 bytes. So MD5 over the UTF-8 encoding of `await response.text()` reproduces the server's hash exactly, including names in Persian or other non-Latin scripts.

`client/src/scripts/local-md5.js` implements MD5 (RFC 1321) in plain JS, because `crypto.subtle` has no MD5 and is missing over plain http. It exports `md5Hex(text)`, `md5HexBytes(bytes)`, `utf8Bytes(text)` and the older async `hashText(text)`. It was checked against the RFC 1321 vectors, the macOS `md5` command (ASCII, Persian, emoji, block-boundary lengths) and node's `crypto` on random Unicode strings, with and without `TextEncoder`. Speed is not a concern: a real 5 KB game state hashes in about 0.06 ms in node, and 50,000 Persian characters (100 KB of UTF-8) in about 1 ms.

Until this fix the client sent a SHA-256 hash (or a 32-bit string hash over http), so no request was ever held and every open board and lobby polled in a tight loop.

### The poll loop

`createLongPoll(options)` in `settings.js` runs one loop. The options are `name`, `url(hash)`, `onUpdate(data, text, hash)` and, optionally, `beforeRequest()`, `onGone(status, text)`, `onError(err, info)` and `indicator`. One cycle:

1. If the tab is hidden, stop here and wait (see below).
2. Run `beforeRequest()`. The pages use it for the cached identity check. An `AuthRejectedError` stops the loop, because the login page is being shown. Any other error counts as a failure.
3. Send the GET with the last rendered hash (`-` at first, which never matches). The request is aborted after 50 s, longer than any server hold.
4. Handle the reply:
   - 204 or 408 means "nothing changed": poll again at once.
   - 200 with JSON whose MD5 differs from the sent hash: call `onUpdate`. The stored hash changes only after `onUpdate` returns, so a render that throws is retried with the same state (with backoff), instead of leaving a half-drawn board until the next change.
   - 200 whose MD5 equals the sent hash: the server should have held the request. This is treated as a misbehaving server and backed off.
   - 401 or 403: drop the identity cache and back off.
   - 400, 404 or 410: if `onGone` returns true, stop for good (used when the LS deletes a finished session); otherwise back off.
   - 5xx, a non-JSON body, or a network error: back off.

Timing rules:

- A new request never starts less than 750 ms after the previous one started. Against the real servers this never delays anything, since held requests take 30 s. It stops any server that answers at once (a mock, a misconfigured proxy, a future hash mismatch) from turning the loop into a hot loop.
- Backoff is exponential with "equal jitter": after the n-th consecutive failure the wait is a random value between d/2 and d, with d = min(30 s, 1 s × 2^(n-1)). So 0.5 to 1 s, then 1 to 2 s, 2 to 4 s, and so on up to 15 to 30 s. Any successful reply resets it.
- While `document.hidden` is true no new request starts. A request already in flight may finish and render. On `visibilitychange` to visible and on `online`, every loop aborts its in-flight request (it may sit on a connection that died during sleep or a network change) and polls at once; a loop waiting out a backoff skips the rest of it. For tests that drive several players in background tabs, `localStorage.setItem("splendorPollWhenHidden", "1")` keeps hidden tabs polling.
- The whole cycle is wrapped, so no exception can end the loop by accident.

Connection problems (network errors, 5xx, non-JSON replies, transient identity failures) do not toast. Instead a shared element `#splendor-connection-indicator` (class `connection-indicator`, `role="status"`) shows "Reconnecting..." in the bottom right corner, styled inline for now so a later UX pass can restyle it. It disappears as soon as every loop has a successful reply again. Errors a user can act on still toast once per distinct message: on the board, a 400 from the GS (the game no longer exists, for example after a GS restart) and a render failure.

Steady-state load: each loop keeps one request open and renews it every 30 s, plus one request per real change. An idle lobby or board sends about two requests a minute per loop instead of hundreds per second.

### Loops per page

- Lobby: one loop on `GET /ls/api/sessions?hash=`. Its `onUpdate` re-renders the session table. The lobby's create, join, leave, delete and launch requests show an error toast on failure (including an unreachable server), and a 401 drops the identity cache so the next action re-verifies. The avatar and role (`getUserDetail`) retry with the same backoff while the server is unreachable, without toasts.
- Lobby, "Load a Game" tab (`lobby-saves.js`): not a poll. Each click lists the saves of every version in `GAME_VERSION_TO_BOARD` from the LS, joins them with the GS details from `GET /gs/api/saves` (name, creator, timestamp), and shows only saves both services know. A save the GS lacks used to crash the timestamp sort and empty the list; an unreachable GS now just gives no rows instead of a raw `TypeError` toast.
- Board: two loops.
  - The game-state loop (`board`) on `GET /gs/api/sessions/<id>?hash=`. Its first cycle verifies the identity and fetches the lobby session once, so player aliases are known before the first render.
  - The lobby-session loop (`board-lobby-session`) on `GET /ls/api/sessions/<id>?hash=`. It refreshes aliases, observer and moderator badges and the moderation buttons the moment they change, independently of game moves. It does not drive the indicator, and it stops when the LS answers 400, which happens once the game is over and the GS has deleted the LS session.

## Game versions

`GAME_VERSION_TO_BOARD` in `settings.js` maps each GS game version to its board page. Its keys are also the versions whose saved games the lobby lists, one request per version, in parallel; a version the server does not register simply contributes no saves.

- `BASE_ORIENT` maps to `gameboard`.
- `BASE_ORIENT_CITIES` maps to `gameboard-cities`. This is Cities without nobles, the official rule and the default.
- `BASE_ORIENT_CITIES_NOBLES` maps to `gameboard-cities`. This is Cities played with nobles as well.
- `BASE_ORIENT_TRADE_ROUTES` maps to `gameboard-tradingposts`.

Use `boardPathForVersion(version)` to build a board path. It accepts the bare version or the LS game-service name (`splendor_<VERSION>`) and returns, for example, `/gameboard-cities/`. For a version the client does not know it throws an `UnknownGameVersionError`, whose message asks the user to reload for the latest client. The lobby shows that message on Play and when copying a migrate link. Before, an unknown version produced `/undefined/`, which Caddy served as the title page.

The lobby's create menu (`pages/lobby.astro`) still lists only the original three versions; offering "Cities with nobles" there is part of the lobby UX work.

Both Cities versions use the same board page, which has five noble slots. In the nobles version the GS deals nobles as in the base game and the board fills the slots. In the no-nobles default the GS sends a `nobleDeck` with no visible cards, so `updateNoblesBoard` fills nothing. A slot that never held a card is `display: none` (`gameboard.css`, `.noble-card:not([card-id]):not([had-card])`), so no empty slots show; only the empty `.board-nobles` container remains in the layout.

## Test hooks

These attributes are a stable contract for end-to-end tests and visual checks. Change them only together with the tests.

On a board page, after every successful render, `document.body` carries:

- `data-splendor-ready="1"` once a game state has been rendered.
- `data-splendor-turn`: the username of the player whose turn it is. It is empty when the game is over or no current player is known.
- `data-splendor-state-hash`: the MD5 of the last rendered state, which is the exact GS response body. A test can compute `md5(await (await fetch(gs + "/api/sessions/" + id)).text())` and wait until the attribute equals it, which proves the board has caught up with the server.
- `data-splendor-game-over="1"` when the game is over. The attribute is absent otherwise.

On the lobby page, `document.body.dataset.splendorLobbyReady` becomes `"1"` after the first successful render of the session list.

On every page that polls, `document.body.dataset.splendorConnection` is `"ok"` or `"reconnecting"`, mirroring the indicator. It is informational and is first set when a loop reports its first outcome.

In Playwright these read naturally as `page.waitForFunction(() => document.body.dataset.splendorReady === "1")` or `expect(page.locator("body")).toHaveAttribute("data-splendor-turn", "alice")`.

## How this was verified

These checks were run on 2026-10-01 and repeated on a second pass. The scripts lived in a session scratch directory and are not part of the repository; the Playwright specs under `client/tests/` are the lasting tests.

- `pnpm --dir client build` succeeds. (Set `SPLENDOR_DIST_DIR` to build somewhere other than `client/dist`, for example while an isolated instance is serving `client/dist`.)
- `local-md5.js` passes 642 checks: the RFC 1321 vectors, the macOS `md5` command on ASCII, Persian, emoji and block-boundary strings, and node's `crypto` on 600 random Unicode strings plus one of 200,000 characters, each with and without `TextEncoder`.
- A private LS and GS (copies of the built jars on random high ports, with a temporary SQLite file) confirmed the server side. With the client's MD5 of the unchanged body, `GET /api/sessions/<id>` on the GS was held and answered 204 after 30.9 s, and `GET /api/sessions` and `GET /api/sessions/<id>` on the LS were held and answered 408 after about 30.2 s. The LS bodies contained Persian display names, so the UTF-8 path is covered. A wrong hash, or the SHA-256 the old client sent, is answered at once.
- A headless Chrome run against that stack, through a small local proxy that serves a client build, counts requests and can simulate an outage, passed 30 checks, among them:
  - logging in through the UI with a Persian display name stores all three identity keys and sets the lobby hook;
  - an idle lobby sends no new session-list request in 12 s, and an idle board keeps one held GS request and one held LS request, with exactly one local-auth request per page load;
  - a session created through the API appears in the open lobby at once;
  - a move made through the API reaches the board in about 0.25 s and moves `data-splendor-turn` on; a moderator change arrives through the LS session loop;
  - a reload during a simulated 502 outage keeps all three identity keys, stays on the page, shows "Reconnecting...", raises no toast, backs off (3 requests in 8 s) and recovers on its own, rendering the move it missed;
  - the cities board renders and sets the hooks.
- A mocked browser run takes the board from a running state into game over: `data-splendor-game-over` appears, `data-splendor-turn` empties, the game-over modal shows and the poll keeps holding.
- Node runs of `createLongPoll` with a fake DOM and a scripted `fetch` cover the 750 ms minimum cycle, the backoff growth, `wake()`, the hidden-tab pause and `visibilitychange`, the hash being kept after a failed render, `onGone`, and the stop on `AuthRejectedError`. Node runs of `verifyCredentials` cover 401, 403, an `unknown_token` 404, 400, 429, a 200 HTML page, the migrate flow and the once-per-page-load cache.
- A mocked browser run of the "Load a Game" tab shows the old build emptying the list with `TypeError: Cannot read properties of undefined (reading 'timestamp')` when the LS lists a save the GS lacks, and the fixed build listing the saves both services know with no toast.
