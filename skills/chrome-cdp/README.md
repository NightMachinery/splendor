# chrome-cdp (moved)

This helper was replaced by the `splendor-browser` skill in
`.claude/skills/splendor-browser/` (also linked for Codex as
`.agents/skills/splendor-browser`). Read its `SKILL.md`.

The new skill launches its own private headless Chrome (no browser on port
9222 needed), seeds players and games through the real APIs (`seed.mjs`),
captures every perspective with real mobile emulation (`shot.mjs`) and
reports layout problems (`probe.mjs`).
