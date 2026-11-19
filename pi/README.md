# pi

Portable pi configuration for this machine.

Tracked:

- `settings.json` — default model/provider, theme, extension packages
- `models.json` — provider and model definitions
- `npm/` — pi extension packages and lockfile
- `themes/omarchy-system.json`
- `extensions/` — user-authored extensions (see its README)

Global rules live at [`../agents/AGENTS.md`](../agents/AGENTS.md) and are
installed to `~/.agents/AGENTS.md` with `~/.pi/agent/AGENTS.md` symlinked by
`scripts/sync-agents-md.sh`.

Not tracked: `auth.json`, `trust.json`, sessions, caches, and the
herdr-managed `extensions/herdr-agent-state.ts`.

`install.sh pi` backs up and copies the tracked files into `~/.pi/agent/`,
installs `pi/npm`, symlinks `pi/extensions/*.ts` and the `mov-skills` skills,
and syncs `~/.agents/AGENTS.md`.
