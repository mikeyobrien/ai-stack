# MOV Skills

Personal agent skills. Every skill folder in
[`skills/`](./skills) becomes an entry in each session's skill catalog, loadable
with the `skill` tool and invocable as `/name` — exactly like any other skill.

The base is intentionally empty: add your own skills to `skills/` and they go
live without reinstalling.

## Add a skill

### Scaffold

Node only — no dependencies, no install step. From the `ai-stack` repo root:

```bash
./packages/mov-skills/new-skill                                    # interview for everything
./packages/mov-skills/new-skill my-skill                           # interview for what's missing
./packages/mov-skills/new-skill my-skill --when "Use when …" --resources references,scripts
```

From this package's root the same entry point is `./new-skill`. The long form
`node packages/mov-skills/scripts/new-skill.mjs` also works from the repo root,
but a `node` path is resolved against the current directory — typed inside
`packages/mov-skills/` it resolves to `packages/mov-skills/packages/mov-skills/…`
and fails. Use the `./new-skill` symlink, which resolves its own location.

With a terminal and no arguments — or with a name but no `--when` — the script
interviews you for the missing pieces, shows a summary, and writes nothing until
you confirm; `n` at the confirmation, Ctrl+C, or Ctrl+D writes nothing. It
validates names and rejects collisions before writing, then copies
`skills/.template/SKILL.md` (dot-prefixed, so discovery ignores it) and creates
the requested resource folders.

Without a terminal (pipes, CI) it never prompts: a name is required, and a
missing `--when` falls back to a placeholder description. Works from any
directory.

### By hand

Create one folder per skill inside `skills/`, with a `SKILL.md` at its root:

```
skills/
  my-skill/
    SKILL.md          ← required: frontmatter + instructions
    references/       ← optional: anything the instructions point at
    scripts/          ← optional
```

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

# My Skill

Step-by-step instructions the agent loads on demand.
```

`name` must be kebab-case and unique; `description` is the routing text the model
sees in the catalog, so write it as "use when …". The folder name is free-form —
the frontmatter `name` is what the catalog uses.

A flat file such as `skills/quick-note.md` also works for skills with no
resources. Keep loose `.md` files out of `skills/` unless you intend them as
skills.

## Frontmatter keys

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Kebab-case identifier used by `skill` and `/name`. |
| `description` | yes | Catalog summary; put the trigger conditions here. |
| `whenToUse` | no | Extra routing guidance for discovery consumers. |
| `disable-model-invocation` | no | `true` keeps it out of the model catalog; only `/name` can load it. |
| `user-invocable` | no | `false` keeps `/name` from loading it; the model can still use it. |
| `metadata` | no | Free-form mapping handed through with the skill. |

Boolean keys accept `true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`. Any other
value drops the skill instead of silently permitting a surface.

## Resources and paths

Instructions may reference files next to `SKILL.md` (for example
`references/details.md` or `scripts/run.sh`). The loaded skill reports its base
directory, so relative paths resolve inside the skill folder. Missing or invalid
skills are skipped with a warning in the host log — the catalog simply does not
show them.

## Live updates

The provider re-reads `skills/` once a second. Adding, renaming, or deleting a
skill (or editing its frontmatter) refreshes the catalog on the next model step;
body-only edits take effect on the next load. No restart, no reinstall.

## Precedence

Packaged skills sit at the bundled rank (600), so a skill with the same name in
your project's `.dsh/skills` or `.agents/skills`, in a configured custom folder,
or in `~/.dsh/skills` / `~/.agents/skills` wins. Keep `mov-skills` for skills
that should travel with the plugin itself.

## Install, update, remove

```bash
# install (approval required in the Harness)
# plugin_manager → install_bundle → target: /home/mobrienv/dsh-workspace/mov-skills
```

The plugin row id is `mov-skills` and the package is `@local/mov-skills`. Local
installation links this checkout, so edits to `index.js`, `skills/`, the locale
files, and the icon apply to the running profile. Adding a new module or asset
requires a restart to load a fresh generation of `index.js`; skills and locale
files do not. To remove it, use `plugin_manager` → `remove_bundle` with
`@local/mov-skills`.

## Files

| Path | Role |
|---|---|
| `index.js` | Skill provider: discovery, frontmatter parsing, load, change watch. |
| `cordis.patch.yml` | Bundle patch that inserts the `mov-skills` plugin row. |
| `skills/` | Your skills. |
| `skills/.template/SKILL.md` | Starter copied by the scaffolder; ignored by discovery. |
| `scripts/new-skill.mjs` | Dependency-free scaffolder. |
| `new-skill` | Symlink to `scripts/new-skill.mjs`; cwd-safe entry point. |
| `locale/*.json` | Plugin Manager title and description (English, Chinese). |
| `icon.svg` | Plugin inventory artwork. |
