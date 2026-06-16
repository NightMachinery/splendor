# Splendor Agent Notes

- Keep `./docs/` updated as you investigate or make changes. If a readme file exists, keep it updated too.
- Stay on the current branch and worktree unless the user explicitly asks you to switch.
- Do not use Docker for local self-host/dev workflows; use `./self_host.py`.
- When developing on a local machine, use `./self_host.py dev-start` instead of `start` unless the user explicitly says otherwise.
- `self_host.py` owns tmux sessions, Caddy config, local ports, and `.self-host/` data. It passes proxy env vars through when present; do not hardcode proxy settings.
- For frontend package operations, use pnpm and the pnpm lock file.
- Skip running `npx @sveltejs/mcp svelte-autofixer`; this repo is Astro/React/vanilla JS and that tool is unreliable.
- If there is too little free disk space to continue, stop and ask the user to handle it manually.
- If the Git worktree is dirty before mutating changes, preserve unrelated user changes and commit your own work atomically at natural endpoints.
