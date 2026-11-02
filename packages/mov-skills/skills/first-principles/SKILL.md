---
name: first-principles
description: "Use when weighing multiple competing options — architecture, tooling, vendors, process, or scope — where the criteria are unclear, the options arrived pre-framed, or the decision is hard to reverse. The inward half of prior-art: derive what should be chosen from goals and constraints, then reconcile it with what has already been tried."
---

# First Principles

## Why

Prior art answers "what has been done"; it cannot answer "what should be done here". Copied solutions carry the constraints of the place they came from, and those constraints are usually left unstated. Reasoning from first principles without prior art has the opposite failure: you pay for lessons the industry already learned.

The two skills are a pair. Prior art is the outward, empirical half (yang): mine implementations, research, base rates, and post-mortems. First principles is the inward, analytical half (yin): strip the problem to goals and constraints, challenge the frame, and derive the option set. Prior art keeps you from reinventing; first principles keeps you from cargo-culting.

## What

A method for turning a contested choice into a defensible decision, designed to run against the prior-art report rather than instead of it:

- every inherited constraint is labelled and tested, not assumed;
- options are derived from primitives and then checked against what has already been tried;
- claims are marked fact, assumption, convention, or preference, with confidence;
- convergence with prior art raises confidence; divergence names the constraint that differs;
- the written brief leads with the recommendation and what would change it.

It covers architecture, tooling, vendors, process, scope, and similar multi-option calls. It does not replace domain expertise; it tells you which expert claim to test. It is not for cheap, reversible choices — take the default, record it, and move on.

## How

1. **Frame the decision.** Write it as a choice with an owner, deadline, and reversibility class: one-way door (expensive to undo) or two-way door (cheap to undo). State what "good" looks like and what would make you regret the choice.
2. **Harvest prior art first.** Run the `prior-art` skill and keep its report beside the decision. Record, for each source: the option it chose, the constraints it assumed, and the failure modes it reported. Prior art supplies the base rate and the candidate pool; it does not decide.
3. **Separate goals from means.** List the outcomes the decision must produce. Rank must-haves against nice-to-haves, and when two criteria conflict, say which wins and why.
4. **Decompose to primitives.** Break the problem into constraints and quantities: money, time, latency, throughput, team capacity, maintenance, risk, lock-in, legal exposure. Mark each constraint as inherited from prior art or true for this problem. Ask "what must be true for this to hold?" and "how would we know?".
5. **Attack the frame.** Invert it: "how would we guarantee failure?". Remove constraints that are merely conventions, including ones imported from prior art. Apply Chesterton's fence: learn why a convention exists before removing it. Check whether the real decision is upstream — scope, timing, ownership.
6. **Derive the option set.** Generate options from the primitives, not from the shortlist. Add the prior-art options as candidates, then add what prior art does not contain: doing nothing, the smallest reversible probe, a hybrid, and a buy/borrow/partner variant. Aim for at least three genuinely distinct options.
7. **Reconcile the two halves.** For each derived option, ask "has this been tried, and what happened?". For each prior-art option, ask "which constraint does it depend on, and does that constraint hold here?". Convergence is evidence; divergence is a question — resolve it by naming the constraint that differs, or by admitting the derivation is wrong.
8. **Evaluate under uncertainty.** Score options against weighted criteria using ranges, not point estimates. Estimate expected value, second-order effects, cost of delay, and option value. When one assumption dominates the spread, test that assumption instead of debating the options.
9. **Red-team, decide, and write the brief.** Pre-mortem the leading choice, compare it with the base rate, and write the strongest case against it. Lead the brief with the recommendation, confidence, what would change your mind, and the review trigger. Prefer a reversible probe to a large irreversible commitment when uncertainty is high.

### Pairing with prior-art

- **Order:** harvest first, derive second. Deriving before looking produces false novelty; looking before deriving produces cargo cults.
- **Prior art sets the base rate and the candidate pool.** First principles sets the criteria and prunes inherited constraints.
- **Agreement is not proof, disagreement is not progress.** When the two disagree, find the specific constraint that differs; that constraint is the real decision.
- **Never let prior art choose the option set, and never let first principles ignore what has already failed.**

### Questions

- Which constraint in the prior-art option does not hold here?
- What has been tried that resembles our derived option, and why did it stop?
- If our answer matches prior art, is that because it is right or because we anchored?
- If our answer differs, is the difference a real constraint or vanity?
- What would have to be true for this option to win? Which of those is least certain?
- Is this a one-way or a two-way door? What does being wrong cost, and how fast could we undo it?
- What is the status quo costing us? Doing nothing is an option with a price.
- Are we comparing on the axis that matters, or optimizing a proxy?
- What are we not measuring? What would we see if this were the wrong choice?

### Gotchas

- **Reinventing the wheel**: deriving without checking prior art; someone has already paid for that lesson.
- **Cargo culting**: copying prior art without checking whether its constraints match this problem.
- **False novelty**: a "first-principles" option that is prior art with a new name.
- **Base-rate neglect**: ignoring how often this class of decision fails for others.
- **False dichotomy**: accepting "A or B" before checking that C, D, and "do nothing" exist.
- **Analogy as evidence**: "company X did it" is a hypothesis, not proof; check whether their constraints match yours.
- **Sunk-cost reasoning**: past spend is not a reason to continue; only future costs and benefits count.
- **Anchoring**: the first plausible option becomes the reference point for every comparison.
- **Premature convergence**: deciding before the option set is diverse or the dominant assumption is tested.
- **Reversibility blindness**: treating a one-way door like a two-way door, or over-deliberating a two-way door.
- **Proxy capture**: optimizing the metric after it stops tracking the goal.
- **Blank-slate arrogance**: discarding a convention without learning why it exists.
