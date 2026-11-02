---
name: write-one-pager
description: "Use when a recommendation is already decided and only the page remains — writes a one-page decision argument with a bounded execution and learning contract."
user-invocable: false
---

# Write One-Pager

## Why

A reader must be able to judge a recommendation and understand what approving it commits them to. A compelling argument alone can leave scope, ownership, and success unclear; a delivery checklist alone cannot justify the choice. Lead with the recommendation, support it with evidence, and close with a bounded next step and a test of success.

## What

A standalone method for turning a decision artifact into one page:

- a governing thought stating the recommendation as an action and intended outcome;
- an explicit approval ask, decision-maker, and needed date where applicable;
- a compact SCQA frame establishing why the decision matters;
- two or three grouped, evidence-backed reasons explaining why this choice wins;
- explicit scope and non-goals, accountable delivery, and resource bounds;
- measurable success, a review checkpoint, and a reversal condition;
- action titles that carry the argument when read alone;
- 400–600 words, one readable page, one decision.

The pyramid controls hierarchy; SCQA frames the decision; Why–What–How checks coverage. They are complementary tools, not three outlines to concatenate. Distinguish **why act** from **why this choice**, and **how to deliver** from **how to know it worked**.

It assumes the recommendation, its confidence, and its reversal condition are already decided. If they are not, the page is premature — return to the decision stage. This format is for decision-oriented work items, not every informational summary.

## How

1. **Name the reader and the decision.** State the one question the page answers and what the reader should approve. Identify the decision-maker and needed date where applicable; distinguish the approver from the delivery owner. Do not invent missing names or dates.
2. **Write the governing thought.** One sentence stating the recommendation as an action and intended outcome — "Adopt X to achieve Y", not "Considerations regarding X". Put the approval ask directly beneath it.
3. **Frame the decision with SCQA.** In two to four sentences, establish shared situation, consequential complication, and the question to resolve. The title already supplies the answer; connect the opening to it without repeating it verbatim. Establish relevance, not inevitability.
4. **Draft the key line.** Choose two or three reasons that together support the recommendation. Keep them the same logical kind, non-overlapping, and collectively sufficient for this decision. Pick one ordering — time, structure, or degree — and hold it.
5. **Prove why this choice wins.** Support each reason with only the evidence it needs. Test vertical logic: each supporting detail must answer the question raised by its parent claim. Address the strongest alternative, including doing nothing where relevant, and the material trade-off. Distinguish observed facts from assumptions; preserve material uncertainty and decision confidence.
6. **Bound the commitment.** Make clear what changes and what does not. Add a compact delivery paragraph naming the accountable owner, smallest useful next step, resource bound, first milestone, and critical dependency where relevant. Link detailed plans rather than listing every task.
7. **Define success and reconsideration.** State an observable baseline and target, review date or checkpoint, and evidence that would cause a stop or revision. If these are missing from the input, mark them as unresolved; do not fabricate metrics or quietly turn assumptions into commitments. Surface any unresolved prerequisite to approval in the ask.
8. **Write action titles and cut.** Every argument heading is a sentence carrying its point, not a topic label such as "Why" or "How". Keep reasoning as the main body; delivery and review should be a short close. Aim for 400–600 words and verify readable page fit when rendered. Cut repetition and link supporting analysis; reduce scope rather than font size or material evidence.
9. **Red-team the page.** Can a reader identify the ask, why action matters, why this choice wins, scope, owner, next step, and success condition without explanation? Check the strongest objection, unsupported claims, stale numbers, missing commitments, and reversal condition. Confirm the order is recommendation, context, reasons, bounded action, review.

### Skeleton

```markdown
# <Action title: recommend X to achieve Y>

Decision requested: <approval> from <decision-maker> by <needed date>.

<Shared situation. Consequential complication. Decision question.>
<Connect to the recommendation without repeating the title.>

## <Action title — first reason this choice wins>
<Claim and only the evidence it needs.>

## <Action title — second reason this choice wins>
<Claim and only the evidence it needs.>

## <Action title — third reason, if needed>
<Claim and evidence. Address the strongest alternative, trade-off,
and material uncertainty within the relevant argument.>

**Delivery.** <Scope and non-goals; accountable owner; resource bound;
smallest useful next step; first milestone; critical dependency.>

**Success and review.** <Observable baseline → target; review date or checkpoint.>
**What would change this.** <Evidence or condition that stops or revises the recommendation.>
```

Adapt the fields to the decision; omit genuinely inapplicable details, not unresolved prerequisites. The strongest alternative and material uncertainty must remain visible even when only two arguments are needed. The skeleton is not a form to fill with invented specifics.

### Questions

- What exactly should the reader approve, and by when?
- Is the governing thought an action and outcome, or merely a topic?
- Does the opening explain why action matters without duplicating the recommendation?
- Do the grouped reasons establish why this choice beats the strongest alternative?
- Are the reasons the same logical kind, with a consistent order and sufficient evidence?
- Which claim would a skeptic attack first? Is its uncertainty visible?
- What is in scope, and what is explicitly not being approved?
- Who owns the next step, within what resource bound, and at what checkpoint?
- What observable result counts as success, and what would reverse the recommendation?
- Can the reader find the decision and commitments without reconstructing the argument?
- What can be cut or linked without weakening the case?

### Gotchas

- **Borrowed conclusion**: writing over a recommendation that was never derived; the page inherits the error.
- **Framework stacking**: separate SCQA and Why–What–How sections repeat the rationale instead of strengthening it.
- **Urgency mistaken for justification**: proving something must change does not prove this solution is best.
- **False inevitability**: persuasive framing hides alternatives or uncertainty; make the case without pretending it is deductively certain.
- **Topic titles**: headings name subjects instead of carrying the argument.
- **Buried conclusion**: building to the answer spends attention before stating the ask.
- **False grouping**: reasons overlap, leave gaps, or mix logical kinds and orders.
- **Evidence dump**: facts that do not support a claim displace the evidence that does.
- **Situation bloat**: background the reader already accepts delays the decision.
- **No counter-case**: deleting all alternatives turns analysis into advocacy; retain the strongest comparison, not the full options matrix.
- **Mini-project plan**: task inventories crowd out reasoning; retain only the bounded commitment and link implementation detail.
- **Unowned approval**: agreement without an accountable next step does not authorize useful action.
- **Invented certainty**: missing owners, dates, metrics, or resource estimates must remain explicit unknowns, not fabricated commitments.
- **Delivery mistaken for success**: completing tasks is not necessarily achieving the intended outcome.
- **No learning loop**: a target without a checkpoint or reversal condition cannot guide reconsideration.
- **Two pages**: cut repetition or narrow scope, not the font or material uncertainty.
- **Scope creep**: one page argues for one bounded decision, not the whole roadmap.
