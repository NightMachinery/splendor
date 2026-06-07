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

Self-hosted auth is local and intranet-friendly. The browser stores a random auth token and display name in `localStorage`; the LobbyService associates that token with the user's display name so the user is not prompted again on refresh. If the browser has no local display name, protected pages redirect straight to the display-name login page instead of showing an in-page prompt.

No external captcha, Google service, or password entry is required for normal self-hosted play. The account settings page keeps colour/account controls but hides password controls, and the shared nav intentionally omits logout to avoid accidentally discarding the local browser identity.

The login page redirects back to the homepage when a local identity already exists. UI error toasts are also mirrored to the browser console for easier copy/paste debugging.


## Generated profile avatars

Player profile icons are generated locally in the browser from the room identity using `nice-avatar-svg`, so profile pictures do not rely on external avatar services and remain stable for the same local account.

## Player recovery and moderation

The self-hosted lobby exposes player management without requiring typed internal IDs. In the lobby, expand a session's **Players / Moderation** panel to see server-provided display aliases, internal IDs on hover, and badges for the current user, owner/mod/temp-mod, and observers.

Allowed actions appear as icon buttons next to each player:

- Copy a migrate link for yourself, or for any player if you are a moderator. The link opens the board as that room identity and is useful after browser storage is cleared or a device changes.
- Move yourself back from observer to player. Moderators can also move other players between player and observer status.
- Promote players to moderator. Demoting moderators remains restricted to the session creator by the LobbyService.

The same badges and moderation buttons are also shown on player panels in launched game boards, so creators and moderators can recover or adjust players after the game starts. Non-moderators only see actions the backend already allows for their own identity.

## Development

Use `dev-start` while changing client code. It leaves the Java services running in tmux and proxies the frontend through Caddy to Astro, so HMR works through the configured URL.

Inspect sessions with:

```bash
tmux ls
tmux attach -t splendor-lobby
tmux attach -t splendor-game
tmux attach -t splendor-client-dev
```
