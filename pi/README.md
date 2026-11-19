# pi

Portable pi configuration for this machine.

Tracked:

- `settings.json` — default model/provider (overridable via `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL`), theme, extension packages
- `models.json` — provider templates using `${PI_*_BASE_URL}` placeholders; `install.sh pi` expands them from the environment / `.env` and drops unconfigured optional providers
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
