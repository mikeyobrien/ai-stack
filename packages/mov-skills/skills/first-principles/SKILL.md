---
name: first-principles
description: Use when weighing multiple competing options — architecture, tooling, vendors, process, or scope — where the criteria are unclear, the options arrived pre-framed, or the decision is hard to reverse. Rebuilds the choice from goals and constraints instead of analogy or convention.
---

# First Principles

## Why

Most decisions are argued by analogy, precedent, or the first plausible option. That is fast and often wrong: the constraints that made a pattern work elsewhere are rarely stated, and the option set is usually inherited rather than derived. This skill makes the assumptions visible and testable before commitment, so the choice survives scrutiny and avoids expensive, hard-to-reverse mistakes.

## What

A method for turning a contested choice into a defensible decision:

- goals and criteria stated before options;
- options generated from primitives, not from the shortlist;
- every claim labelled fact, assumption, convention, or preference, with confidence;
- a written brief that leads with the recommendation and names what would change it.

It applies to architecture, tooling, vendors, process, scope, and similar multi-option calls. It does not replace domain expertise or prior art: it tells you which expert claim to test and which assumption dominates. It is not for cheap, reversible choices — take the default, record it, and move on.

## How

1. **Frame the decision.** Write it as a choice with an owner, deadline, and reversibility class: one-way door (expensive to undo) or two-way door (cheap to undo). State what "good" looks like and what would make you regret the choice.
2. **Separate goals from means.** List the outcomes the decision must produce. Rank must-haves against nice-to-haves, and when two criteria conflict, say which wins and why.
3. **Decompose to primitives.** Break the problem into constraints and quantities: money, time, latency, throughput, team capacity, maintenance, risk, lock-in, legal exposure. Label each claim as fact, assumption, convention, or preference. Ask "what must be true for this to hold?" and "how would we know?".
4. **Attack the frame.** Invert it: "how would we guarantee failure?". Remove constraints: "what if budget, legacy, or headcount were not factors?". Apply Chesterton's fence to existing conventions: learn why they exist before removing them. Check whether the real decision is upstream — scope, timing, or ownership — rather than among the options given.
5. **Expand the option set.** Generate options from the primitives. Always include doing nothing, the smallest reversible probe, a hybrid, and a buy/borrow/partner variant. Aim for at least three genuinely distinct options.
6. **Evaluate under uncertainty.** Score options against weighted criteria using ranges, not point estimates. Estimate expected value, second-order effects, cost of delay, and option value. When one assumption dominates the spread, test that assumption instead of debating the options.
7. **Red-team the leader.** Pre-mortem the top choice, compare it with the base rate for this class of decision, and write the strongest case against it. Name the assumption that, if false, flips the decision.
8. **Decide and write the brief.** Lead with the recommendation. Record confidence, the evidence behind it, what would change your mind, and the review trigger. When uncertainty is high, prefer a reversible probe to a large irreversible commitment.

### Questions

- What would have to be true for this option to win? Which of those is least certain?
- Is this a one-way or a two-way door? What does being wrong cost, and how fast could we undo it?
- What is the status quo costing us? Doing nothing is an option with a price.
- Are we comparing on the axis that matters, or optimizing a proxy?
- What is the base rate for this kind of decision, and why would we beat it?
- Would we choose this if it were the default, or only because it is the incumbent?
- What are we not measuring? What would we see if this were the wrong choice?
- If we had to ship in one week, what would we do? What does that reveal about the real constraint?

### Gotchas

- **False dichotomy**: accepting "A or B" before checking that C, D, and "do nothing" exist.
- **Analogy as evidence**: "company X did it" is a hypothesis, not proof; check whether their constraints match yours.
- **Sunk-cost reasoning**: past spend is not a reason to continue; only future costs and benefits count.
- **Anchoring**: the first plausible option becomes the reference point for every comparison.
- **Premature convergence**: deciding before the option set is diverse or the dominant assumption is tested.
- **Reversibility blindness**: treating a one-way door like a two-way door, or over-deliberating a two-way door.
- **Proxy capture**: optimizing the metric after it stops tracking the goal.
- **Blank-slate arrogance**: discarding a convention without learning why it exists.
