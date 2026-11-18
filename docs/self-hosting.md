# Self-hosting Splendor

Splendor runs as three processes on one machine, without Docker:

- the **Lobby Service (LS)**, vendored in `setup/LobbyService` and built with
  its SQLite profile. It owns users, sessions and the game service registry;
- the **game server (GS)** in `server/`. It owns the running games;
- a **web front**: Caddy serving the built client (`client/dist` for the
  default instance, the instance's own copy for a named one), or the Astro
  dev server in dev mode. It also proxies `/ls/*` to the LS and `/gs/*` to the
  GS, because the browser always calls `${origin}/ls` and `${origin}/gs`.

`./self_host.py` builds these, picks ports, writes the front's config and runs
each process in its own detached tmux session. It can run two kinds of
deployment:

- the **default instance** is the production deployment. Its data lives
  directly in `.self-host/`, its public site is a managed block in
  `~/Caddyfile`, and its tmux sessions are `splendor-lobby`, `splendor-game`
  and `splendor-client-dev`. The live server's tooling relies on these names.
- a **named instance** (`instance-start NAME`) is an isolated copy for tests
  and visual checks. It has its own data directory, its own ports, its own
  private Caddy, its own client build, and tmux sessions named
  `splendor-NAME-*`. It never touches `~/Caddyfile`, the system Caddy,
  `client/dist` or the default instance.

Security notes, the token model and known gaps are in
[security.md](security.md).

## Commands for the default instance

```bash
./self_host.py setup     [--url https://splendor.pinky.lilf.ir]
./self_host.py redeploy  [--url ...] [--force]
./self_host.py start     [--url ...]
./self_host.py dev-start
./self_host.py stop
./self_host.py status
```

- `setup` installs the client dependencies, builds everything, then starts
  production hosting with the default ports.
- `redeploy` rebuilds the current checkout and swaps it in with as little
  downtime as possible. See "Safer redeploy" below. It does not `git pull`.
- `start` restarts production hosting from the jars already built in
  `target/`, without building.
- `dev-start` installs the client dependencies and builds the jars, then
  runs the LS, the GS and the Astro dev server (hot reload). It is meant for
  a local machine; see "Local development".
- `stop` kills the default instance's tmux sessions and waits until their
  ports are released. A JVM left behind on one of those ports is killed by PID,
  but only when its command line names our jar and that port.
- `status` prints the recorded ports, whether each session runs and whether
  each port is listening. It is read-only.

The default URL is `https://splendor.pinky.lilf.ir`. If the configured URL is
HTTPS, the managed Caddy block also redirects HTTP to HTTPS, and the other way
round for an HTTP URL.

## Isolated instances

```bash
./self_host.py instance-start NAME [--mode static|dev] [--no-build]
./self_host.py instance-stop NAME
./self_host.py instance-status NAME
```

Use these for end-to-end tests, screenshots and any other check that needs the
real stack. Never point such checks at the production deployment. Several
instances can run at the same time (for example `e2e` and `cdp`). Names use
lowercase letters, digits, `-` and `_`, at most 32 characters.

`instance-start NAME`:

1. stops the instance first if it was running (a restart keeps its data);
2. in `--mode static` (the default), rebuilds the instance's own client,
   `<instance>/dist`, if any client source is newer than it. The build goes
   to a staging directory and is moved into place by renaming, so the front
   never serves a half-written `dist`. With `--no-build` it keeps the
   instance's `dist` as it is, or copies `client/dist` if the instance has
   none yet. In `--mode dev` it only makes sure `client/node_modules` exists;
3. copies `setup/LobbyService/target/ls.jar` and
   `server/target/splendorGame.jar` into the instance, so a later rebuild
   cannot change them under the running JVMs. It never builds the jars: if one
   is missing it stops with the Maven command to run;
4. picks three free ports (lobby, game, web), starting at 35100 and skipping
   every port the default instance or another instance has recorded. The
   choice runs under a lock, and a port stays the same across restarts while
   it is free;
5. starts the LS, waits for `GET /api/online`, starts the GS, and waits until
   every expected game service is listed by `GET /api/gameservices` and the
   GS has logged that registration finished;
6. starts the web front and checks that `/ls/api/online` and `/gs/api/online`
   answer through it;
7. writes `instance.json` and prints the same JSON.

If any step fails, it prints the tail of the relevant log, stops the instance
again and exits non-zero. `instance.json` looks like this:

```json
{
  "name": "e2e",
  "mode": "static",
  "baseUrl": "http://127.0.0.1:35102",
  "lsUrl": "http://127.0.0.1:35100",
  "gsUrl": "http://127.0.0.1:35101",
  "ports": {"lobby": 35100, "game": 35101, "web": 35102},
  "dataDir": "/path/to/splendor/.self-host/instances/e2e",
  "distDir": "/path/to/splendor/.self-host/instances/e2e/dist"
}
```

`distDir` (static mode only) is the client build the front serves.

`baseUrl` is the web front: open it in a browser, and call `baseUrl/ls/...`
and `baseUrl/gs/...` to go through the same routes and rules as production.
`lsUrl` and `gsUrl` are the backends directly, which skips the route rules.

The two web fronts:

- `--mode static` runs a private Caddy (`caddy run --config
  <instance>/Caddyfile --adapter caddyfile`). Its config has `admin off` and
  `auto_https off`, listens on 127.0.0.1 only, and keeps Caddy's state under
  `<instance>/caddy`. It serves the instance's own `dist` with the same SPA
  fallback, the same `/ls` and `/gs` proxies and the same route rules as the
  production block.
- `--mode dev` runs `astro dev` on the web port, with the Vite proxy described
  in "Local development" and its own Vite cache directory.

A static instance has its own client build because a shared `client/dist`
would tie every front to it. Replacing it under a running front breaks the
pages already open there: they ask for hashed `/_astro/` files that no longer
exist, and the SPA fallback answers those with `index.html`. On the
production server it would also put a new client in front of the old
backends before `redeploy` ran. The cost is one client build per instance
after each client change (about 11 seconds on a recent laptop) and about 7 MB
of disk per instance. To point other tools at the same build, read
`distDir` from `instance.json`.

`instance-stop NAME` kills the instance's tmux sessions, waits until its ports
are released, kills any leftover java or caddy process started from the
instance directory (matched by literal paths, by PID), and removes
`instance.json`. It exits non-zero if a port is still busy. It only ever
targets that instance's sessions.

`instance-status NAME` prints JSON with each session's state, the ports and
whether they listen, the log directory and the contents of `instance.json`.
It exits 0 only when the instance is fully up. It changes nothing.

A stopped instance keeps its data, so its users and saves survive a restart.
To start from scratch, stop it and delete `.self-host/instances/NAME`.

Every test run adds users to the instance's database, because each new
browser token or API login creates one. That is harmless in an instance and
one more reason never to test against production.

## Local development

On a local machine, use `./self_host.py dev-start` (or an instance with
`--mode dev`). It works the same on macOS and Linux:

- the Astro dev server proxies `/ls/*` and `/gs/*` itself and strips the
  prefix, as Caddy's `handle_path` does (`client/astro.config.mjs`). Its
  targets come from `SPLENDOR_LS_URL` and `SPLENDOR_GS_URL`, which
  `self_host.py` sets for the dev session. When they are unset (for example a
  hand-run `pnpm dev`), it falls back to the ports in `.self-host/ports.json`,
  then to the default ports;
- the dev proxy answers 403 for the same service-only routes as Caddy, so
  dev mode is no more open than production;
- the dev server listens on 127.0.0.1 only, and dev mode never edits
  `~/Caddyfile`. The client pins Vite 4, whose dev server has known file-read
  bugs, so it must never be exposed publicly;
- the printed URL is `http://127.0.0.1:<dev port>`, and it works as is.

`dev-start` replaces whatever the default instance was running. Do not run it
on the production server.

## Routes and the web front

Every web front, production or private, routes requests the same way:

- `/ls/*` goes to the LS with the `/ls` prefix removed;
- `/gs/*` goes to the GS with the `/gs` prefix removed;
- everything else is a static file from the front's client build
  (`client/dist`, or `<instance>/dist` for a named instance), with a
  fallback to `index.html`.

Two kinds of request are refused from the public side with 403, because only
the backends themselves make them and they talk over 127.0.0.1 directly:

- any method other than GET on an LS path that contains `/gameservices`
  (registering or unregistering a game service, savegame writes);
- any PUT on the GS except a player action,
  `PUT /gs/api/sessions/{id}/players/{player}/actions/{action}`. This blocks
  the LS-to-GS launch call `PUT /api/sessions/{id}`, which has no
  authentication.

Both JVMs listen on 127.0.0.1 only, so these rules cannot be skipped by
calling the backend ports from outside.

## Data layout

The default instance keeps everything in `.self-host/` (gitignored); a named
instance keeps the same files in `.self-host/instances/NAME/`:

- `lobby.sqlite`: the LS database. It holds every player and their token in
  plain text, so the directory is mode 0700.
- `saves/`: game saves written by the GS.
- `service-token`: the secret service token, mode 0600 (see
  [security.md](security.md)). It is generated on first start and kept.
  Delete it to rotate the token; the LS rotates its stored service account on
  the next start.
- `ports.json`: the ports this deployment uses.
- `logs/`: service output (see "Logs").
- `jars/`: the copies of `ls.jar` and `splendorGame.jar` the JVMs run from.
- named instances only: `dist/` (the instance's own client build, static
  mode), `Caddyfile`, `caddy/` (the private Caddy's state), `vite-cache/`
  (dev mode) and `instance.json` (while running).
- `.self-host/build/` (shared): the staging area for jars. A redeploy keeps
  the next jars, the previous build and, after a rollback, the failed build
  (`build/failed/`) there.
- `client/node_modules/.cache/splendor-dist-staging-PID/`: where client
  builds of any instance go before they are moved into `client/dist` or
  `<instance>/dist`. It has to be inside `client/`: Astro 2.0.13 builds an `outDir` outside its
  working directory in `client/.astro` first and deletes that folder before
  its copy to `outDir` has finished, so such a build fails at random with
  ENOENT once the site has enough files.

These are inside the repository directory, so `git clean -fdx` deletes them,
including every user account. Back up `lobby.sqlite` and `saves/` before
anything like that.

## Logs

Each service's stdout and stderr are written to its tmux pane and also to a
log file, so the output survives a crash:

- `logs/lobby.log`, `logs/game.log`;
- `logs/client-dev.log` for a dev server, `logs/web.log` for a private Caddy.

On each start the previous run's file is kept as `NAME.log.1`. To watch a
service live, attach to its session, for example `tmux attach -t
splendor-lobby` (detach with `C-b d`). With tmux's `remain-on-exit` on, a
crashed service leaves a dead pane behind; the script treats a session whose
pane is dead as stopped.

## Safer redeploy

On the production server, run:

```bash
git pull && ./self_host.py redeploy
```

`redeploy` keeps the site up while it builds and stops only when the new build
is ready:

1. It asks the LS for its sessions. Sessions and running games live only in
   memory, so a restart deletes them. If there are any, it prints them (id,
   game, waiting or launched, players) and refuses, unless `--force` is
   given.
2. It builds the client into a staging directory and both jars with
   `mvn clean package` (tests, javadoc, PMD and checkstyle skipped). The
   running services are not affected: they run from the copies in
   `.self-host/jars`, and Caddy keeps serving the old `client/dist`.
3. It checks for sessions again, since players may have started one during
   the build.
4. It stops the services, moves the new `dist` and jars into place by
   renaming (keeping the previous ones in `.self-host/build/previous`), and
   starts them.
5. It waits until every expected game service is registered with the LS.
6. If the new build does not come up, it stops it, puts the previous `dist`
   and jars back, starts them, and exits non-zero. The failed build stays in
   `.self-host/build/failed`, and its logs are `logs/lobby.log.1` and
   `logs/game.log.1`.

A failed build (a compile error, a full disk, no network) therefore leaves the
old deployment running untouched. Downtime is the time the two JVMs need to
start and register: about 12 seconds on a recent laptop, and probably closer
to a minute on a 1 vCPU server (not measured there).

The first redeploy of a deployment started by an older `self_host.py`, which
ran straight from `target/`, first copies those jars into `.self-host/jars`,
so it can roll back too.

Disk: a redeploy needs room for a second `dist` and for two more copies of
the jars (about 90 MB per set) while it runs.

Memory: the JVM heaps are capped so both fit a 3 GB server next to Caddy.
`SPLENDOR_LS_HEAP` and `SPLENDOR_GS_HEAP` set the caps (default `384m` each;
any value `java -Xmx` accepts, such as `512m` or `1g`). Instances use the same
caps.

## Ports

The default instance uses lobby 34172, game 33402 and dev 38932, recorded in
`.self-host/ports.json`. A start keeps a recorded port while it is free or
still held by the default instance's own session for that role. Only a port
taken by another program moves, to the next free one, and only then is
`ports.json` rewritten. `status` never probes for new ports or rewrites the
file.

Named instances allocate their ports from 35100 upward, as described above,
and record them in their own `ports.json`.

## Environment variables

- `SPLENDOR_LS_HEAP`, `SPLENDOR_GS_HEAP`: JVM heap caps (default `384m`).
- `SPLENDOR_START_TIMEOUT`: seconds to wait for each service to start or
  register (default 240). A service that exits fails the start at once.
- `SPLENDOR_EXPECTED_SERVICES`: comma-separated game service names a start
  waits for. The default is `splendor_BASE_ORIENT`,
  `splendor_BASE_ORIENT_CITIES`, `splendor_BASE_ORIENT_CITIES_NOBLES` and
  `splendor_BASE_ORIENT_TRADE_ROUTES`. A GS that registers more still
  passes, because the start also waits for the GS's own "Registered game on
  lobby service" log line, which it prints after the last registration. A
  jar built before Cities with nobles existed registers only three, so a
  start with such a jar times out unless this variable lists those three.
- `SPLENDOR_LS_URL`, `SPLENDOR_GS_URL`: backend targets of the Astro dev
  proxy.
- `SPLENDOR_DIST_DIR`: output directory of `pnpm build` (Astro's `outDir`);
  the script uses it to build into staging. Keep it inside `client/` (see
  the staging note under "Data layout"); an absolute path there is fine.
- `SPLENDOR_VITE_CACHE_DIR`: Vite cache directory, so several dev servers can
  run from one checkout.
- `SPLENDOR_SERVICE_TOKEN` (LS) and `LS_SERVER_PASSWORD` (GS): set by the
  script from the `service-token` file. Do not set them by hand.

## Dependencies

Install these tools on the host:

- Java 17 or newer
- Maven
- Node and pnpm (use pnpm for client dependencies, never npm)
- tmux
- Caddy (for production and for static instances)
- lsof

The script passes existing proxy variables (`ALL_PROXY`, `http_proxy`,
`HTTPS_PROXY`, `NO_PROXY`, `npm_config_proxy` and so on) through to pnpm and
to the tmux sessions, and never hardcodes a proxy. Maven ignores those
variables, so for builds an `http(s)://host:port` proxy is also translated
into `MAVEN_OPTS` system properties. Credentials in the proxy URL and SOCKS
proxies are not translated, and whether Maven's artifact resolver honours
these properties has not been tested; if downloads fail behind a proxy, add a
`<proxies>` entry to `~/.m2/settings.xml`.

The tmux sessions inherit the tmux server's environment, so the script also
passes `PATH` and `JAVA_HOME`, to run the same java, node and pnpm it checked.

## Intranet and local operation

The app works over HTTP as well as HTTPS. Browser APIs such as the clipboard
use local fallbacks where needed, and the client derives the service URLs from
the current origin (`/ls` and `/gs`) instead of a hardcoded public server.
