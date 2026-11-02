# ai-stack

Personal AI tooling in one repo: DeepSeek Harness plugins, agent skills, and pi
configuration/extensions.

```text
ai-stack/
├── dsh/profile/                 # portable DSH profile (bundles + patch)
├── packages/                    # DSH plugins (pnpm workspace)
│   └── mov-skills/              # skills provider; skills live in skills/
├── pi/                          # pi settings, models, instructions, extensions
│   ├── settings.json
│   ├── models.json
│   ├── AGENTS.md
│   ├── npm/                     # pi extension packages
│   ├── themes/
│   └── extensions/              # user pi extensions
└── install.sh
```

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
| `packages/mov-skills` | linked into that profile |
| `packages/mov-skills/skills/*` | also symlinked into `~/.pi/agent/skills/` |
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

## Sharing

Push the repo, clone it on the other machine, set the two env vars, run
`./install.sh`. DSH and pnpm must be on `PATH`; the profile pins the DSH peer
ranges it was built against (`0.2.1-rc.5`).

## Repo location

The checkout currently lives inside the DSH workspace because the live `web`
profile links `mov-skills` through a compatibility symlink at the workspace
root. Moving the repo elsewhere is fine — rerun `./install.sh dsh` afterwards,
then delete the root `mov-skills` symlink once `web` points at the repo path.

The live `web` profile still lists the removed plugins; clear them there with
`dsh plugin --profile web remove @local/openclaw-memory
@local/workspace-agent-renamer` before restarting.
