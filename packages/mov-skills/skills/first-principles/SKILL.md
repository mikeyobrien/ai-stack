---
name: first-principles
description: "Use when weighing multiple competing options — architecture, tooling, vendors, process, or scope — where the criteria are unclear, the options arrived pre-framed, or the decision is hard to reverse. Rebuilds the choice from goals and constraints instead of analogy or convention."
---

# First Principles

## Why

Most decisions are argued by analogy, precedent, or the first plausible option. That is fast and often wrong: the constraints that made a pattern work elsewhere are rarely stated, and the option set is usually inherited rather than derived. This skill makes the assumptions visible and testable before commitment, so the choice survives scrutiny and avoids expensive, hard-to-reverse mistakes.

## What

A standalone method for turning a contested choice into a defensible decision:

- goals and criteria stated before options;
- options generated from primitives, not from the shortlist;
- every claim labelled fact, assumption, convention, or preference, with confidence;
- a written brief that leads with the recommendation and names what would change it.

It covers architecture, tooling, vendors, process, scope, and similar multi-option calls. It does not replace domain expertise or prior art — both are evidence to test, not answers to copy — and it works when no such material exists. It is not for cheap, reversible choices: take the default, record it, and move on.

## How

1. **Frame the decision.** Write it as a choice with an owner, deadline, and reversibility class: one-way door (expensive to undo) or two-way door (cheap to undo). State what "good" looks like and what would make you regret the choice.
2. **Collect the evidence you already have.** Prior art, benchmarks, post-mortems, and expert opinion are inputs, not answers. For each, record the option it chose, the constraints it assumed, and the failure modes it reported. If none exists, proceed from the primitives.
3. **Separate goals from means.** List the outcomes the decision must produce. Rank must-haves against nice-to-haves, and when two criteria conflict, say which wins and why.
4. **Decompose to primitives.** Break the problem into constraints and quantities: money, time, latency, throughput, team capacity, maintenance, risk, lock-in, legal exposure. Mark each constraint as inherited or true for this problem. Ask "what must be true for this to hold?" and "how would we know?".
5. **Attack the frame.** Invert it: "how would we guarantee failure?". Remove constraints that are merely conventions, including imported ones. Apply Chesterton's fence: learn why a convention exists before removing it. Check whether the real decision is upstream — scope, timing, ownership.
6. **Derive the option set.** Generate options from the primitives, not from the shortlist. Add existing patterns as candidates, then add what they do not contain: doing nothing, the smallest reversible probe, a hybrid, and a buy/borrow/partner variant. Aim for at least three genuinely distinct options.
7. **Reconcile with what is known.** For each derived option, ask "has this been tried, and what happened?". For each existing pattern, ask "which constraint does it depend on, and does that constraint hold here?". Agreement is evidence; disagreement is a question — resolve it by naming the constraint that differs, or by admitting the derivation is wrong.
8. **Evaluate under uncertainty.** Score options against weighted criteria using ranges, not point estimates. Estimate expected value, second-order effects, cost of delay, and option value. When one assumption dominates the spread, test that assumption instead of debating the options.
9. **Red-team, decide, and write the brief.** Pre-mortem the leading choice, compare it with the base rate, and write the strongest case against it. Lead the brief with the recommendation, confidence, what would change your mind, and the review trigger. Prefer a reversible probe to a large irreversible commitment when uncertainty is high.

### Questions

- What would have to be true for this option to win? Which of those is least certain?
- Is this a one-way or a two-way door? What does being wrong cost, and how fast could we undo it?
- What is the status quo costing us? Doing nothing is an option with a price.
- Are we comparing on the axis that matters, or optimizing a proxy?
- What is the base rate for this kind of decision, and why would we beat it?
- What has been tried that resembles this option, and why did it stop?
- If our answer matches precedent, is that because it is right or because we anchored?
- What are we not measuring? What would we see if this were the wrong choice?
- If we had to ship in one week, what would we do? What does that reveal about the real constraint?

### Gotchas

- **Reinventing the wheel**: deriving without checking what is already known; someone has already paid for that lesson.
- **Cargo culting**: copying a pattern without checking whether its constraints match this problem.
- **False novelty**: a "first-principles" option that is an existing pattern with a new name.
- **Base-rate neglect**: ignoring how often this class of decision fails for others.
- **False dichotomy**: accepting "A or B" before checking that C, D, and "do nothing" exist.
- **Analogy as evidence**: "company X did it" is a hypothesis, not proof; check whether their constraints match yours.
- **Sunk-cost reasoning**: past spend is not a reason to continue; only future costs and benefits count.
- **Anchoring**: the first plausible option becomes the reference point for every comparison.
- **Premature convergence**: deciding before the option set is diverse or the dominant assumption is tested.
- **Reversibility blindness**: treating a one-way door like a two-way door, or over-deliberating a two-way door.
- **Proxy capture**: optimizing the metric after it stops tracking the goal.
- **Blank-slate arrogance**: discarding a convention without learning why it exists.
