# Splendor Agent Notes

- Keep `./docs/` updated as you investigate or make changes. If a readme file exists, keep it updated too.
- Stay on the current branch and worktree unless the user explicitly asks you to switch.
- Do not use Docker for local self-host/dev workflows; use `./self_host.py`.
- When developing on a local machine, use `./self_host.py dev-start` instead of `start` unless the user explicitly says otherwise.
- `self_host.py` owns tmux sessions, Caddy config, local ports, and `.self-host/` data. It passes proxy env vars through when present; do not hardcode proxy settings.
- End-to-end tests, screenshots and any other check against the real stack must use an isolated instance (`./self_host.py instance-start NAME`, then `instance-stop NAME`), never the production deployment and never the default instance (`splendor-lobby`, `splendor-game`, `splendor-client-dev`), which other sessions may be using. Read `baseUrl`, `lsUrl` and `gsUrl` from `.self-host/instances/NAME/instance.json`. Use a name of your own (for example `e2e` or `cdp`) so parallel runs do not collide. `instance-start` never builds the jars; if one is missing it prints the Maven command. Stop your instances when you are done. See `docs/self-hosting.md`.
- Never edit `~/Caddyfile` or reload the system Caddy by hand; instances run their own private Caddy.
- Security-relevant behaviour (service token, blocked routes, room tokens) is described in `docs/security.md`. Keep it current when you change auth or routing.
- For frontend package operations, use pnpm and the pnpm lock file.
- Skip running `npx @sveltejs/mcp svelte-autofixer`; this repo is Astro/React/vanilla JS and that tool is unreliable.
- If there is too little free disk space to continue, stop and ask the user to handle it manually.
- If the Git worktree is dirty before mutating changes, preserve unrelated user changes and commit your own work atomically at natural endpoints.
- For screenshots, mobile/responsive checks and layout probes of the client as any player, use the `splendor-browser` skill (`.claude/skills/splendor-browser/SKILL.md`, linked for Codex at `.agents/skills/splendor-browser`). It runs a private headless Chrome against an isolated instance.
