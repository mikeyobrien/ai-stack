---
name: verified-delivery
description: "Use when building or changing a feature in a running application, and before reporting it done — writes user-visible acceptance checks first, picks the least invasive extension point, verifies the user path rather than the plumbing, and reports what is verified versus unverified."
---

# Verified Delivery

## Why

The expensive failure in feature work is not a bug; it is a confident "done" on something that does not work. Code compiles, the plugin installs, the slot registers, the write reaches disk — and the user still sees a blank panel. Once "done" means the plumbing ran, every later claim inherits the error, and the user becomes the person who discovers it. This skill exists to make that specific failure expensive to commit.

## What

A delivery gate for any feature that lands in a running app:

- acceptance checks written as sentences a user would say;
- an explicit regression contract for what must keep working;
- the weakest extension point that delivers the capability;
- a both-directions check on every new call across a boundary;
- verification of the user path, not the transport;
- a report that separates what was observed from what was assumed.

It does not cover research (`prior-art`), choosing between options (`first-principles`), or reviewing an already-running UI (`ui-ux-pass`). It assumes the app can be driven. When it cannot, the report changes; the standard does not.

## How

1. **Write the acceptance checks before the code.** One sentence per check, in the user's voice: "I open a `.md` and see rendered Markdown." "I select a line and get a note." Each must be observable without reading source. If you cannot write one, the requirement is not understood yet.
2. **Write the regression contract.** Name what must not change: files that opened before, previews that rendered before, shortcuts that worked before. A feature that breaks a neighbour is a net loss, whatever else it does.
3. **Choose the weakest extension point that delivers the capability.** Prefer an additive affordance — a button, a popover, a menu entry — over replacing a renderer, router, or handler. Outranking a shipped component means taking over its whole job, including the parts you never considered.
4. **Name every substitution when you make it.** If the request was an attachment and the available API yields text, say so at decision time and state the consequence. A silent substitution becomes a bug report later.
5. **Check every new boundary in both directions.** For each new call across a process, module, or service boundary, unwrap the result and exercise one success and one failure path. A contract discovered on one call is a hypothesis about the boundary, not a fact about that one call.
6. **Verify the user path, not the transport.** Drive the real entry point and observe what the user would see. A write reaching disk proves the write, not the view. If all you exercised was plumbing, say "plumbing verified, view unverified."
7. **Report in two columns.** For each acceptance check, record what you observed and by what means. Everything you did not observe is unverified — including "it should work, the code is simple."
8. **Gate completion on observation.** Do not call the work complete while a check is failing or unobserved. Complete means the checks passed by observation, or you explicitly decided to ship with named gaps.

For the failure sequence this gate was derived from, read `references/sidebar-editor-postmortem.md`.

### Gotchas

- Stub tests pass while the real component throws; a stub that drops children hides a broken tree.
- A test shaped around what is easy to observe will pass and prove nothing. Ask whether it would fail if the feature were absent.
- Installing and registering prove wiring, not rendering. A slot can be active and its body can throw.
- Fixing a symptom twice before finding the cause is the signal to stop patching and read the contract.
- The page you are looking at may be stale. Reloading is part of verification, not cleanup.
- A plan or invariant list that no check enforces prevents nothing.
- Answering a defect report with a description of the fix is not a fix. Implement it, then verify it.
