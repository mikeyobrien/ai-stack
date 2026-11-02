# pi

Portable pi configuration for this machine.

Tracked:

- `settings.json` — default model/provider, theme, extension packages
- `models.json` — provider and model definitions
- `AGENTS.md` — global agent rules (`~/.claude/CLAUDE.md` symlinks here)
- `npm/` — pi extension packages and lockfile
- `themes/omarchy-system.json`
- `extensions/` — user-authored extensions (see its README)

Not tracked: `auth.json`, `trust.json`, sessions, caches, and the
herdr-managed `extensions/herdr-agent-state.ts`.

`install.sh pi` backs up and copies the tracked files into `~/.pi/agent/`,
installs `pi/npm`, and symlinks the `mov-skills` skills into
`~/.pi/agent/skills/`.
