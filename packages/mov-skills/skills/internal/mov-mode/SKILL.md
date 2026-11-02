---
name: mov-mode
description: "Use when running a named flow — resolves a flow from its own table and threads an artifact through its stages. The entry point for composition; individual skills stay single-purpose."
user-invocable: false
---

# Mov Mode

Flows are data in `references/flows.md`: a name and an ordered vector of skill names.

## How

1. Read `references/flows.md`; resolve the requested flow to its vector.
2. Make a run directory: `.agents/scratch/<YYYY-MM-DD>-<slug>/`.
3. Start the value as the work item.
4. For each stage in order: load that skill, give it the current value as its main input, and have it write `<run-dir>/<stage>.md`.
5. Pass that path as the next value.
6. Stop if a stage writes a blocked artifact; report its reason.
7. Return the last artifact's path.

The runner knows no skill names: they come from the vector. Add or reorder stages by editing the data.

## Gotchas

- **Runner logic in a skill**: a skill that names other skills has leaked the composition; move the names into `references/flows.md`.
- **Artifact by summary**: pass the file path, not a recap; a summary drops evidence.
- **Silent skip**: a stage that does nothing writes a blocked artifact with the reason.
