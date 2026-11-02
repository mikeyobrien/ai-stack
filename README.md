# ai-stack

Personal AI tooling in one repo: DeepSeek Harness plugins, agent skills, and pi
configuration/extensions. Published as-is — tuned for one machine, not a
supported product.

```text
ai-stack/
├── dsh/profile/                 # portable DSH profile (bundles + patch)
├── docs/                        # experimental capability runbook
├── packages/                    # DSH plugins (pnpm workspace)
│   ├── dsh-backlog/             # park ideas; explicitly pull into a draft
│   ├── dsh-client-sidebar-editor/  # opt-in sidebar file editor
│   ├── dsh-principles/          # principles as a prompt section + tools
│   └── mov-skills/              # skills provider; serves ../skills/
├── pi/                          # pi settings, models, instructions, extensions
│   ├── settings.json
│   ├── models.json
│   ├── AGENTS.md
│   ├── npm/                     # pi extension packages
│   ├── themes/
│   └── extensions/              # user pi extensions
├── skills/                      # user-level skills, distributed here
│   ├── delegate/  first-principles/  html-report/  improve-readability/
│   ├── one-pager/  prior-art/  research/  ui-ux-pass/  verified-delivery/
│   └── internal/                # flows composed from the others
└── install.sh
```

`.agents/skills/` holds skills scoped to this checkout only.

## Install

```sh
export SPARKS_API_KEY=...
export DSH_SPARKS_BASE_URL=http://your-host:8888/v1

./install.sh          # DSH profile + pi config
./install.sh dsh      # DSH only
./install.sh pi       # pi only

dsh --profile meta
```

`install.sh` writes the profile to `$DSH_HOME/profiles/meta` (override with
`PROFILE=...`) and leaves your working `web` profile untouched. Existing files
are backed up beside themselves as `*.bak-<timestamp>` first. It also runs
`pnpm install` at the repo root so `packages/mov-skills` has its `yaml`
dependency wherever the checkout lives.

## What lands where

| Repo | Machine |
| --- | --- |
| `dsh/profile/*` | `$DSH_HOME/profiles/$PROFILE/` |
| `packages/*` | linked into that profile |
| `skills/*` | your user-level skills; also symlinked into `~/.pi/agent/skills/` |
| `pi/settings.json`, `models.json`, `AGENTS.md` | `~/.pi/agent/` |
| `pi/npm/package.json` | `~/.pi/agent/npm/`, then `npm install` |
| `pi/themes/omarchy-system.json` | `~/.pi/agent/themes/` |

`~/.claude/CLAUDE.md` already symlinks to `~/.pi/agent/AGENTS.md`, so the same
global rules reach Claude too.

## Portability

- **Secrets stay out**: `SPARKS_API_KEY` comes from the environment;
  `~/.dsh/.credentials.yaml` and pi's `auth.json`/`trust.json` are never copied.
- **Host values are env-driven**: the profile reads `DSH_SPARKS_BASE_URL` with a
  localhost default. Trusted hosts still come from `dsh web --trusted-host`.
- **Paths are computed at install**: the profile ships `link:@REPO@/...` specs
  and `install.sh` rewrites them to this checkout's absolute path.
- **Sessions and workspaces are not included**: they embed absolute cwds and
  belong to each machine.

## Adding things

- **DSH plugin**: add `packages/<name>/` with a `dsh.bundle.patch`, add the
  package to `dsh/profile/package.json` dependencies and bundles, then
  `./install.sh dsh`.
- **Skill**: `packages/mov-skills/new-skill <name>`. It appears in the DSH
  catalog on the next poll; run `./install.sh pi` to expose it to pi as well.
- **pi extension**: drop a `*.ts` file in `pi/extensions/` and run
  `./install.sh pi`; npm-based extensions go in `pi/npm/package.json` plus
  `settings.json`'s `packages` list.

## Plugin resolution

The plugin packages import `@deepseek-ai/*` without declaring it, so those
imports resolve through the harness the plugins run inside, not through this
workspace's own dependencies. `install.sh` links the install's `node_modules`
one level above the checkout to supply exactly the installed versions:

```text
~/dsh-workspace/node_modules -> ~/.local/share/dsh/node_modules
```

That link is load-bearing, not leftovers: remove it and a plugin still loads
from the profile, then fails the moment Node resolves its import. Override the
target with `DSH_PACKAGES` when the harness lives elsewhere.

## Experimental capabilities

Switched-on experimentals, the ones that are explicit compositions rather than
toggles, and the version-pinning rule for their packages:
[docs/experimental-capabilities.md](docs/experimental-capabilities.md).

## Session backlog

The [Session backlog plugin](<packages/dsh-backlog/README.md>) adds **Park** and
**Backlog** beside the composer. Park ideas without interrupting the agent; pull
selected ideas into a draft later, then send separately. Saved ideas persist at
workspace scope, with recoverable pulled/dismissed history.

## Hooks

Run `pnpm hooks` once per clone. The pre-commit hook validates every skill's
YAML frontmatter and refuses the commit when a description would break the
catalog — for example, an unquoted colon.

## Sharing

Clone it on another machine, set the two env vars, run `./install.sh`. DSH and
pnpm must be on `PATH`; the profile pins the DSH peer ranges it was built
against (`0.2.1-rc.5`).

## License

MIT — see [LICENSE](LICENSE). Bundled third-party work keeps its own terms:

| Path | Terms |
| --- | --- |
| `packages/dsh-principles/principles/` | MIT, © 2026 Lauren Tan ([pstack](https://github.com/cursor/plugins)); see `LICENSE-pstack.txt` there |
| `skills/html-report/vendor/mermaid.min.js` | Vendored Mermaid, MIT; provenance in `vendor/README.md` |
