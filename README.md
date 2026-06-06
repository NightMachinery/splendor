# Splendor
An online multiplayer web-based implementation of the strategy game Splendor, adapted for local self-hosting.

## Features
 * Splendor with Orient Expansion
 * Splendor with Orient Expansion + Trading Routes
 * Splendor with Orient Expansion + Cities
 * Custom Noble and Custom City
 * Online multiplayer experience
 * Game spectator feature
 * Exciting animations

## Getting Started

For self-hosting without Docker, see [docs/self-hosting.md](docs/self-hosting.md).

See [here](setup/readme.md) if you wish to develop the frontend/backend.

## Setup

### Self-hosting

Use the non-Docker self-hosting helper:

```bash
./self_host.py setup
```

The default URL is `https://splendor.pinky.lilf.ir`; pass `--url` to use another absolute HTTP or HTTPS URL. See [docs/self-hosting.md](docs/self-hosting.md) for details.

## Gameplay

![splendor](https://user-images.githubusercontent.com/17598972/229967618-cb24d268-fe54-40e8-bd1d-9526f44069ca.gif)

Upon startup, you will be greeted by the Splendor title page. Simply click to log in.

You may now log in to one of the preconfigured Lobby Service accounts made by an administrative user.

This will now take you to the lobby screen. You can either start up a brand new game or load a previously saved game. All previously saved games can be loaded by any player and only require the same number of players to launch. The upper righthand corner features the settings and logout buttons.

All players have access to the settings page and will be able to change their colors and passwords here.

Admin accounts will also notice an admin zone button in the upper lefthand corner. The admin zone allows admin accounts to add, delete, or modify user accounts and force unregister game services.

Hovering over the "Create Session" button allows you to choose the game version to play. You will see the newly created game appear once you click on one of the three versions.

The game requires at least two players. Players can click on “Join” to join a game. Notice that only the creator has the permission to delete an unlaunched game.

The creator can launch the game once enough players have gathered.

Every player should click on "Play" to show the game board.

![taketurn](https://user-images.githubusercontent.com/17598972/229967691-fcfe0cb8-6931-40de-8de5-df8660833f57.gif)

During your turn, you may either take tokens according to game rules, purchase a card, or reserve a card. As the game progresses, additional actions may be unlocked and automatically added to your turn.

