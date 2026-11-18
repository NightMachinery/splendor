# Splendor
An online multiplayer web-based implementation of the strategy game Splendor, adapted for local self-hosting.

## Features
 * Splendor with Orient Expansion
 * Splendor with Orient Expansion + Trading Routes
 * Splendor with Orient Expansion + Cities (the official rule without nobles, or a variant with nobles)
 * Custom Noble and Custom City
 * Online multiplayer experience
 * Game spectator feature
 * Exciting animations

## Responsive UI and live E2E

Play with **2 to 4 players** from a desktop, tablet or phone. Create a session
in the lobby and ask the other players to **Join**. Once a second player joins,
the host can select **Start game** and everyone can select **Play**. During a
turn, use **View board** to check the table before returning to your action.
Tap a card to read its details. Purchases suggest an exact payment you can edit.
[Responsive layout and browser testing](docs/responsive-and-e2e.md)

## Getting Started

Everything runs without Docker through `./self_host.py`, which builds the
Lobby Service, the game server and the client, and runs each in a tmux
session. See [docs/self-hosting.md](docs/self-hosting.md) for every command,
the data layout and the logs, and [docs/security.md](docs/security.md) for
the token model and known gaps.

You need Java 17 or newer, Maven, Node, pnpm, tmux, Caddy and lsof. Use pnpm
(never npm) for the client.

### Local development

```bash
./self_host.py dev-start
```

This builds the jars and starts the Lobby Service, the game server and the
Astro dev server with hot reload, then prints a local URL
(`http://127.0.0.1:<port>`). The dev server proxies `/ls` and `/gs` itself, so
it works on macOS and Linux without Caddy.

### Tests and visual checks

End-to-end tests, screenshots and other checks against the real stack use an
isolated instance, never the production deployment:

```bash
./self_host.py instance-start e2e      # prints JSON with baseUrl, lsUrl, gsUrl
./self_host.py instance-stop e2e
```

Each instance has its own database, ports, private Caddy and logs under
`.self-host/instances/NAME`, and several can run at once.

`setup/readme.md` is the original course setup guide (Docker, MySQL) and does
not describe this workflow.

## Setup

### Self-hosting

On the server, the first time:

```bash
./self_host.py setup
```

To deploy new commits later:

```bash
git pull && ./self_host.py redeploy
```

`redeploy` builds first and stops the running site only once the build has
succeeded. It refuses while games are in progress (they live in memory and
would be lost) unless you pass `--force`, and it rolls back to the previous
build if the new one does not start.

The default URL is `https://splendor.pinky.lilf.ir`; pass `--url` to use
another absolute HTTP or HTTPS URL. See
[docs/self-hosting.md](docs/self-hosting.md) for details.

## Gameplay

![splendor](https://user-images.githubusercontent.com/17598972/229967618-cb24d268-fe54-40e8-bd1d-9526f44069ca.gif)

Upon startup, you will be greeted by the Splendor title page. Click to continue, then choose a display name.

There are no passwords. Your browser keeps a random token that identifies you, so come back in the same browser to stay the same player. To play as yourself on another device or tab, use a migrate link (see below).

This will now take you to the lobby screen. You can either start up a brand new game or load a previously saved game. All previously saved games can be loaded by any player and only require the same number of players to launch. The upper righthand corner features the settings and logout buttons.

All players have access to the settings page, where they can change their colour or delete their account.

Self-hosting creates no admin account. The admin zone (adding, deleting or modifying user accounts, force-unregistering game services) only appears for an account whose role was set to admin by hand in the Lobby Service database.

The "Create Session" button lets you choose the game version to play. You will see the newly created game appear once you click on one of the three versions.

A game takes two to four players. Players can click on “Join” to join a game. Notice that only the creator has the permission to delete an unlaunched game.

The host can select **Start game** when the lobby says the session is ready.

Every player should click on "Play" to show the game board.

Creators and moderators can use the lobby **Players / Moderation** panel, and matching controls on launched boards, to copy player migrate links, move observers back into seats, and manage moderators without typing player IDs.

![taketurn](https://user-images.githubusercontent.com/17598972/229967691-fcfe0cb8-6931-40de-8de5-df8660833f57.gif)

During your turn, you may either take tokens according to game rules, purchase a card, or reserve a card. As the game progresses, additional actions may be unlocked and automatically added to your turn.

