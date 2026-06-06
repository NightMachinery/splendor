# Self-hosting Splendor

This repository can be self-hosted without Docker using Caddy and tmux.

## Requirements

Install these tools on the host:

- Java and Maven
- Node/pnpm
- Caddy
- tmux

If your network needs a proxy, export the proxy variables in your shell before running the script. `self_host.py` passes existing proxy variables into tmux sessions, but does not hardcode proxy settings.

## Commands

From the repository root:

```bash
./self_host.py setup [--url https://splendor.pinky.lilf.ir]
./self_host.py redeploy [--url https://splendor.pinky.lilf.ir]
./self_host.py start [--url https://splendor.pinky.lilf.ir]
./self_host.py stop
./self_host.py dev-start [--url https://splendor.pinky.lilf.ir]
```

Default URL is `https://splendor.pinky.lilf.ir`.

- `setup` stops managed sessions, installs/builds, updates `~/Caddyfile`, and starts production.
- `redeploy` stops managed sessions, rebuilds latest local changes, updates Caddy, and starts production.
- `start` stops both production and development sessions before starting production.
- `dev-start` stops both modes, starts Astro's hot-reload dev server, and rewrites the Caddy block to proxy the frontend to it.
- `stop` kills only tmux sessions managed by this script.

The script checks required local ports before startup. Current ports are:

- Lobby service: `34172`
- Game server: `33402`
- Astro dev server: `3000`

## Caddy

`self_host.py` maintains a marked Splendor block in `~/Caddyfile` and reloads Caddy. In production, Caddy serves `client/dist` directly and proxies API paths:

- `/ls/*` → LobbyService
- `/gs/*` → Splendor game server

If the configured URL is HTTPS, the script adds an explicit HTTP→HTTPS redirect block. If the configured URL is HTTP, it adds an HTTPS→HTTP redirect block.

## Authentication

Self-hosted auth is local and intranet-friendly. The browser stores a random auth token in `localStorage`; the LobbyService associates that token with the user's display name so the user is not prompted again on refresh.

No external captcha or Google service is required.

## Development

Use `dev-start` while changing client code. It leaves the Java services running in tmux and proxies the frontend through Caddy to Astro, so HMR works through the configured URL.

Inspect sessions with:

```bash
tmux ls
tmux attach -t splendor-lobby
tmux attach -t splendor-game
tmux attach -t splendor-client-dev
```
