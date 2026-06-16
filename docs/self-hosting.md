# Self-hosting Splendor

Splendor can run without Docker on one machine using tmux-managed services and a
Caddy reverse proxy. The helper script manages builds, ports, Caddy config, and
service sessions.

## Commands

```bash
./self_host.py setup [--url https://splendor.pinky.lilf.ir]
./self_host.py redeploy [--url https://splendor.pinky.lilf.ir]
./self_host.py start [--url https://splendor.pinky.lilf.ir]
./self_host.py dev-start [--url https://splendor.pinky.lilf.ir]
./self_host.py stop
./self_host.py status
```

- `setup` stops any existing tmux sessions, installs/builds everything, then
  starts production hosting.
- `redeploy` stops, rebuilds latest local changes, and starts production hosting.
- `start` stops both production/dev sessions and starts from already-built
  artifacts.
- `dev-start` stops existing sessions, builds backend jars, starts the Astro dev
  server for hot reload, and points Caddy at it. On macOS it serves directly on
  localhost and prints that local URL.
- `stop` kills the Splendor tmux sessions.
- `status` prints persisted ports and tmux session state.

The default URL is `https://splendor.pinky.lilf.ir`. If the configured URL is
HTTPS, the script also adds an HTTP-to-HTTPS redirect block. If the configured URL
is HTTP, it adds an HTTPS-to-HTTP redirect block.

## Runtime layout

- Lobby Service: tmux session `splendor-lobby`
- Game Service: tmux session `splendor-game`
- Astro dev server: tmux session `splendor-client-dev` (`dev-start` only)
- Persistent local data: `.self-host/`
- Caddy config block: `~/Caddyfile`, delimited by `# BEGIN splendor self-host
  managed block` and `# END ...`

Production hosting serves static files directly from Caddy using
`client/dist`; no extra static file server is kept running. API paths are proxied:

- `/ls/*` -> Lobby Service
- `/gs/*` -> Game Service

## Ports

The helper defaults to uncommon local ports and persists the last used values in
`.self-host/ports.json`. If a chosen port is busy, it scans upward for a free
port and stores the replacement.

## Dependencies

Install these tools on the host:

- Java 17+
- Maven
- pnpm
- tmux
- Caddy

Use pnpm for frontend dependencies. The script passes through any existing proxy
environment variables (`ALL_PROXY`, `http_proxy`, `npm_config_proxy`, etc.) to
pnpm/Maven and tmux sessions, but does not hardcode a proxy.

## Intranet/local operation

The app is intended to work over HTTP as well as HTTPS. Browser APIs such as
clipboard use local fallbacks where needed, and the frontend determines service
URLs from the current origin (`/ls` and `/gs`) rather than hardcoding a public
server.
