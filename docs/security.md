# Security notes for the self-hosted deployment

This page describes what an attacker on the internet can reach on the public
server, what has been fixed, what is still open, and how tokens move between
the browser, the Lobby Service (LS) and the game server (GS). Commands and
file locations are in [self-hosting.md](self-hosting.md).

## Threat summary

The public server is a small VPS (one vCPU, about 3 GB of RAM, a nearly full
disk). Caddy is the only thing listening publicly. It serves the client and
proxies `/ls/*` to the LS and `/gs/*` to the GS. Anyone on the internet can
send any request to those two prefixes.

What is worth protecting:

- **The service token.** The LS gives it the service role. With it, a caller
  can unregister game services (which also deletes every session of that
  game), delete running sessions, and register a fake game service whose
  location the LS will later call, with TLS checks off, from the server itself.
- **Player tokens.** Self-host login has no password: a player is whoever
  holds the token the browser generated and stored in localStorage. Losing
  the token loses the account, and leaking it hands the account over.
- **The backends' unauthenticated internal calls.** The LS launches a game by
  calling `PUT /api/sessions/{id}` on the GS, which checks nothing.
- **CPU, memory and disk.** One vCPU is easy to saturate, and sessions and
  games live in memory.

## What was fixed

### A secret service token per data directory

Before: the LS accepted a hard-coded constant (`selfhost_service_token`) from
its public source code as the service identity, and `self_host.py` passed it
on the GS command line, visible in `ps`.

Now:

- The LS reads the token from the environment variable
  `SPLENDOR_SERVICE_TOKEN`. Only when the variable is unset does it fall back
  to the legacy constant, and then it logs a loud warning at startup.
- At startup the LS updates its stored service account (`xox`) to the current
  token and its OAuth password, so a rotated token replaces the old one. A
  stored account with the service role no longer grants anything unless its
  token is the configured one.
- `self_host.py` generates `selfhost_svc_` followed by 48 random hex
  characters once per data directory, in `.self-host/service-token` (or
  `<instance>/service-token`), mode 0600.
- The token never appears on a command line. The tmux shell reads the file
  into `SPLENDOR_SERVICE_TOKEN` for the LS and into `LS_SERVER_PASSWORD` for
  the GS (Spring's relaxed binding maps it to `LS.server.password`). `ps` and
  the tmux arguments show only the file's path.
- The token keeps the `selfhost_` prefix on purpose: the GS uses a password
  that starts with `selfhost_` directly as its token
  (`server/.../control/Authentication.java`) instead of requesting an OAuth
  token.

To rotate it, stop the deployment, delete the `service-token` file and start
again.

### Backends on loopback, service-only routes refused at the front

- The LS and GS listen on 127.0.0.1 only, so the public side reaches them
  only through Caddy.
- Caddy (the production block and every instance's private Caddyfile)
  answers 403 for:
  - any non-GET request to an LS path that contains `/gameservices`, matched
    case-insensitively anywhere in the path, so variants with `;x`, dot
    segments or percent-encoding are caught too. That covers registering and
    unregistering game services and savegame writes;
  - any PUT to the GS except a player action,
    `PUT /gs/api/sessions/{id}/players/{player}/actions/{action}`. That
    blocks the unauthenticated launch call `PUT /gs/api/sessions/{id}`. Each
    segment of the allowed pattern must not start with a dot, so `..` cannot
    turn an allowed path into a blocked one.
- The Astro dev server applies the same rules in a small Vite middleware, so
  a dev front is no more open than production.
- Nothing legitimate is lost: the GS registers with the LS, and the LS
  launches games on the GS, over 127.0.0.1 directly.

This was checked with curl through an instance: every variant above returned
403, `GET /ls/api/gameservices` still worked, and a player action still
reached the GS.

### Migrate links no longer leak the account

`GET /api/sessions/{id}/migrate/{roomToken}` returned the whole player record,
including the player's primary token and the password hash, to anyone holding
the link. It now returns only `name`, `displayName` and `preferredColour`. The
client reads `name`.

### Room tokens work, with a narrow scope

A **room token** (`room_...`) is what a migrate link carries. A moderator or
the player mints one with `POST /api/sessions/{id}/players/{p}/migrate-token`,
so another tab or device can play as that player in that one session without
the primary token.

Before, the LS's OAuth filter rejected room tokens with 401 before any
controller ran, so a migrated tab could not act: even the GS's identity check
(`GET /oauth/username`) failed. Now:

- the filter accepts a room token with the authority `ROLE_ROOM` and the
  principal `room:<user>`, which never equals a real username, so no
  role-protected endpoint accepts it and no "is this you" check matches it;
- `/oauth/username` and `/oauth/role` resolve it to the user, so the GS
  accepts the player's actions;
- the LS's own session endpoints accept it only for the session it was minted
  for (minting a further link, the observer toggle, the moderator toggle);
- it cannot read or change the account, create sessions, or act in any other
  session.

Room tokens live in the LS's memory and disappear when it restarts.

### Cheaper local-auth

`POST /api/local-auth` is open to everyone, and each new token creates a user.
The token was hashed with BCrypt cost 12, about half a CPU second per call on
a fast laptop, so a slow trickle of requests could saturate the server's one
CPU. The plain token is stored in the same row anyway, so the slow hash
protected nothing. Token-derived passwords now use cost 4, about 20 ms per new
user.

### Operational fixes with a security angle

- `dev-start` no longer puts the Vite 4 dev server behind the public Caddy
  block. That Vite version has known dev-server file-read bugs. Dev servers
  listen on 127.0.0.1 only.
- The data directory is mode 0700 and log files are 0600, because the SQLite
  database holds every player's token.
- `redeploy` builds before it stops anything and rolls back a build that does
  not start, so a broken commit or a full disk no longer takes the site down.

## How tokens flow

- **Player token.** The browser generates 48 random hex characters, stores
  them in localStorage as `accessToken`, and sends them with a display name to
  `POST /ls/api/local-auth`. An unknown token creates a player whose username
  is derived from the display name; a known token returns that player. The
  browser then sends the token as the `access_token` query parameter on LS
  and GS calls. The GS checks it by asking the LS
  (`GET /oauth/username`, `GET /oauth/role`).
- **Room token.** Minted by the LS for one player in one session, carried in
  a migrate link (`?sessionId=...&migrate=room_...`), kept in the tab's
  sessionStorage, and sent as `access_token` like a player token.
- **Service token.** Generated by `self_host.py`, stored in the data
  directory's `service-token` file, handed to both JVMs through environment
  variables. The GS sends it to the LS to register its game services and to
  delete a session when a game ends. It never leaves 127.0.0.1.
- **OAuth tokens.** The LS's original OAuth2 password grant
  (`POST /oauth/token`, client `bgp-client-name`) still works. A self-host
  player's password is a BCrypt hash of their token, so the grant needs the
  token anyway. These tokens expire after 600 seconds and live in memory.

## What remains

These are known and not fixed yet, roughly in order of importance:

- **No rate limit or quota on local-auth.** Every request with a new token
  adds a permanent row to the SQLite database, on a nearly full disk. Cost 4
  removed the CPU cost, not the growth. A per-IP rate limit needs a Caddy
  plugin or a check in the LS.
- **Game state is public.** `GET /gs/api/sessions/{id}` needs no token, and
  `GET /ls/api/sessions` lists every session id and its players, so anyone
  can watch any game. The state includes every player's `reservedCards`,
  which the physical game keeps hidden when a card is reserved blind from a
  deck. (The decks themselves expose only their face-up cards.) Fixing it
  means filtering hidden information per viewer in the GS.
- **The GS never forgets a game.** Games stay in the GS's memory after they
  end, and anyone can create sessions, so memory grows until a restart. The
  heap cap (`SPLENDOR_GS_HEAP`) turns that into a crash instead of a
  swapping server.
- **The LS launches blindly.** It marks a session launched before calling the
  GS and ignores the GS's reply, so a failed launch leaves a stuck session
  that only a service or admin can delete. Self-host has no admin account.
- **Joining a launched session.** The LS lets more users join a session after
  launch, while the GS game keeps its original players.
- **Lax location check.** The LS's game service location check uses a
  substring match, so a caller with the service role could register any URL.
  The secret token and the Caddy rule keep callers without it out.
- **Tokens in URLs.** Tokens travel as query parameters, so they would show up
  in any access log that records full URLs. The managed Caddy block does not
  enable access logs; keep it that way, or redact the query.
- **Tokens in localStorage.** Any script injection on the site can read the
  player's token, which is the whole account.
- **The legacy constant still exists.** An LS started by hand without
  `SPLENDOR_SERVICE_TOKEN` accepts the public constant again (with the
  warning). Always start it through `self_host.py`.
- **The OAuth client secret is public** (`bgp-client-pw` in both source
  trees). It only matters together with a user's password, which for
  self-host players means their token.
- **Same-user access.** The service token is readable by the account that runs
  the services (the file, and the JVMs' environment). Anyone with a shell as
  that user has full control anyway.
