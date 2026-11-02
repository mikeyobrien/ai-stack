---
title: Ship the two-column report layout
subtitle: Decision brief for the Q4 documentation work
date: 2026-11-02
status: proposed
audience: Engineering lead deciding whether to fund the rewrite
decision: Approve one week to rebuild the report renderer around a fixed template.
lede: The renderer already exists and works; the cost is the template, not the code.
---

# Ship the two-column report layout

Reports are written as Markdown and read as Markdown. Evidence lives in a
sibling folder, so the reader opens a file, follows a sentence that names a
screenshot, and hunts for the picture that would make the claim checkable.

## The cost is smaller than it looks

The parser, the template, and the diagram rendering are done. What remains is
the visual layer: a measure that reads, figures that are larger than the prose,
and a register that suits the reader.

::: metrics
- 66 | Characters per line | target band is 45–90
- 17 px | Body size | floor for web reading
- 0 | Dependencies | already shipped
- 1 week | Estimate | one engineer
:::

## What we tried

| Option | Verdict | Cost |
|---|---|---|
| Hand-author HTML per report | fail | every report differs |
| Install pandoc | skipped | new toolchain, same template work |
| Renderer with a fixed template | pass | built |

::: quote The template is the product
Every report that looked good used the same shell.
:::

## Recommendation

Approve the week. The renderer is already in the repository, and the remaining
work is CSS and a documented input format, not a service to operate.

::: note What would change this
If two consecutive reports need layout the template cannot express, the template
is the wrong abstraction and the week should buy a different one.
:::
