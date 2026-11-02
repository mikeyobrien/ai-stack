---
name: one-pager
description: "Use when aligning on a new work item — runs the align-work-item flow (prior-art → first-principles → write-one-pager) and returns a one-page pyramid narrative."
---

# One-Pager

An alias for a flow, not a method. The flow table and the runner are in the `mov-mode` skill.

## How

1. Load the `mov-mode` skill; its `references/flows.md` holds the `align-work-item` vector.
2. Run that vector with the mov-mode procedure: thread the work item through each stage, writing `<run-dir>/<stage>.md` and passing the path forward.
3. Return the last artifact — the page — and its path.

Do not restate or re-implement the stages. If the flow changes, this alias follows the data.
