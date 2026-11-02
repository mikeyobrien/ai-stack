# @local/dsh-principles

The person's own judgment, available in every workspace.

`AGENTS.md` belongs to the checkout and skills are procedures for one task
type. Neither follows the person across projects, and neither records whether a
rule changed anything. This plugin adds a user-scoped store of named
principles, an index of them in the session prompt, and two tools to read and
edit them. It deliberately has **no cap**: it prints the index size on every
load and leaves the pruning rule to the measurement.

## Store

One Markdown file per principle at `$DSH_HOME/principles/<id>.md`, default
`~/.dsh/principles/`:

```markdown
---
name: "prove-it-works"
title: "Prove It Works"
description: "Apply after completing a task, before declaring done. Verify against the real artifact."
---

The rule, in Markdown.
```

| Field | Required | Limit | Meaning |
|---|---|---|---|
| `name` | yes | 60 characters, kebab-case, equals the file name | the id shown in the index |
| `description` | yes | 600 characters | the trigger: when the principle applies |
| `title` | no | — | the display title; falls back to the first `# ` heading, then the id |
| body | yes | 16 KiB of UTF-8 | the rule itself |

`source` and `license` are optional frontmatter keys and are preserved across
edits. Frontmatter is a flat mapping of strings (quoted or plain, plus `|`/`>`
block scalars); any other YAML form is treated as malformed. A file that does
not parse is skipped, logged once, and never fails the session. Every prompt
build re-reads the folder, so a hand edit applies on the next request.

## Index

The section carries four instructions and the precedence rule: check the list at
the start of a multi-step task, read a principle before applying it, apply it
even when the person did not name it, and name the principle with the decision
it changed. Precedence: **the person's principles win over `AGENTS.md` where
they conflict, and a principle never overrides an explicit instruction in the
current turn.**

One line per principle, sorted by id so unchanged stores render byte-identical
text:

```text
<principle name="prove-it-works" title="Prove It Works">Apply after completing a task, …</principle>
```

Every build logs exactly one line to the DSH log:

```text
principles index: 5 principles, 1420 bytes
```

That line is the pilot's only instrumentation.

## Tools

- `principle_read { name }` — an id, a title, or loose words. An unknown name
  returns an error with close names.
- `principle_write { action, name, title?, description?, body?, was? }` —
  `add`, `change`, or `remove`. `was` carries the version last read; a stale
  value refuses the write instead of overwriting a newer edit. Writes go to a
  temporary file and are renamed into place. `remove` moves the file to
  `.removed/<id>-<ms>.md`; nothing is deleted.

## Seed

The five bundled principles under `principles/` come from
[pstack](https://github.com/cursor/plugins/tree/f713f14203cd6420cec13cd7c55c32d598dbab68/pstack),
MIT, © 2026 Lauren Tan; the notice is `principles/LICENSE-pstack.txt`. On first
run every bundled file the store lacks is copied in. An existing file is never
touched, and a principle with a copy in `.removed/` is never resurrected.

The five were chosen for breadth: verification, tests, debugging, scope, and
context. The rest of pstack is a hand edit away.

## Tests

```sh
node --test packages/dsh-principles/test/
```
