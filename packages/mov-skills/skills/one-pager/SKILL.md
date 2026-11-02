---
name: one-pager
description: "Use when aligning on a new work item — mines the prior art, derives the choice from first principles, then writes the one-page narrative in pyramid order. One pass from open question to an approvable page."
---

# One-Pager

## Why

A work item usually reaches the reader as a pile: context, options, caveats, and the conclusion near the bottom. The reader has to reconstruct the point before they can judge it, and most will not. Barbara Minto's pyramid principle fixes the order of that reconstruction — conclusion first, supporting arguments grouped beneath it, evidence under each argument, and every level answering the question the level above raises.

The page is also only as good as the decision under it, and the decision is only as good as the evidence under that. A clean page over a borrowed conclusion is a persuasive mistake. So this skill runs the whole arc: mine what exists, derive the choice from goals and constraints, then align on the page.

## What

A standalone method that takes a work item from open question to approvable page in three stages:

- **Mine** — the `prior-art` skill: what exists, what it assumed, and what failed.
- **Derive** — the `first-principles` skill: the choice from goals and constraints, not from the shortlist.
- **Align** — this skill: one page that leads with the recommendation and supports it in pyramid order.

The page itself carries:

- a governing thought that states the recommendation as an action;
- an SCQA opening that makes the recommendation feel inevitable;
- a key line of three to five arguments, the same kind of thing, in a deliberate order;
- evidence under each argument, only as much as the argument needs;
- action titles that carry the argument when read alone;
- one page, one decision.

It covers proposals, project kickoffs, design bets, and scope changes — anything where a reader must say yes, no, or "change this". It is not a status report, a spec, or a persuasion piece with no decision behind it. It assumes nothing is settled: stages 1 and 2 produce the decision, and stage 3 writes it.

## How

The first two stages are the other skills; this one supplies the handoff and the page.

1. **Mine — run the `prior-art` skill.** Give it the work item, the decision the page must support, and the audience. Ask for the shortlist, the constraints each option assumes, what failed, the gaps, and sources with dates. Skip only if you already hold citable evidence.
2. **Derive — run the `first-principles` skill.** Give it the evidence base, the goals, and the reversibility class. Ask for the recommendation, its confidence, the assumption that dominates the spread, and the condition that would reverse it. Skip only if the decision is made and cheap to undo.
3. **Align — write the page.** The recommendation and its supporting points are now fixed; what remains is ordering and compression. Follow the moves below.

### Align — write the page

1. **Name the reader and the decision.** Write the one question the page must answer, who answers it, and what they should do after reading.
2. **Write the governing thought.** One sentence stating the recommendation as an action — "Adopt X for Y by Z", not "Considerations regarding X".
3. **Draft the key line.** List the three to five points that together prove the governing thought. Make them the same kind of thing and MECE: no overlap, nothing a skeptic would ask for is missing.
4. **Order the key line.** Pick one ordering and hold it: time, structure, or degree. Do not mix orders inside one group.
5. **Test vertical logic.** For each point, write the question it raises, then make the evidence beneath answer exactly that question.
6. **Write the SCQA opening.** Situation, complication, question, answer — three to five sentences, making the recommendation feel inevitable rather than displaying the work.
7. **Write action titles.** Every heading is a full sentence carrying its point. A reader who reads only the titles should get the argument.
8. **Fill the evidence, then cut to one page.** Add only what each argument needs, then cut repeated context, background the reader already has, and every option you are not recommending. Aim for 400–600 words.
9. **Red-team the page.** Read as a skeptic: which claim is unsupported, which number is stale, which objection is missing? Add the strongest counter-case and the reversal condition, then confirm the order is conclusion, reasons, detail.

### Skeleton

```
# <Action title: the recommendation as a sentence>

<SCQA, 3–5 sentences: Situation. Complication. Question. Answer.>

## <Action title — first key-line point>
<The point, then only the evidence it needs.>

## <Action title — second key-line point>
<...>

## <Action title — third key-line point>
<...>

**What would change this.** <The evidence or condition that reverses the recommendation.>
```

### Questions

- What is the one question this page answers, and who is asking it?
- Which stage did I skip, and what justified it?
- Did the handoff carry the constraints, or only the links?
- What did the evidence change about the option set?
- Is the recommendation derived or inherited?
- Are the key-line points the same kind of thing, and do they cover the whole case?
- What order are they in, and is that the order the reader needs?
- What question does each point raise, and does the evidence answer it?
- Which claim would a skeptic attack first, and where is its support?
- What would reverse the recommendation, and is that stated?
- What can be cut without weakening the argument?
- Does the page still work if the reader only reads the titles?

### Gotchas

- **Borrowed conclusion**: writing the page over a decision inherited from prior art instead of deriving it.
- **Silent skipping**: going straight to the page without mine or derive, and without saying why.
- **Reference without handoff**: loading the other skills but not telling them what the page needs — no decision frame, no audience — so their output does not fit.
- **Skill ping-pong**: running derive as a formality and then re-deciding inside the page; the recommendation must come from stage 2.
- **Analysis without a page**: deriving forever and never aligning; the page is the deliverable.
- **Topic titles**: a heading that names a subject instead of stating a point hides the argument.
- **Buried conclusion**: building to the answer for suspense spends the reader's attention and returns nothing.
- **False grouping**: points that are not the same kind of thing cannot be ordered or summarized.
- **Overlap and gaps**: non-MECE arguments double-count and leave the skeptic's question unanswered.
- **Label summaries**: a parent idea that restates its children ("three considerations") adds a level without adding meaning; it must summarize them.
- **Evidence dump**: every fact you have is not evidence; include what the argument needs and cut the rest.
- **Situation bloat**: background the reader already accepts delays the point.
- **Two pages**: a one-pager that spills over has not been prioritized; cut an argument, not the font.
- **Mixed order**: switching from importance to chronology mid-group makes the reader re-orient.
- **No counter-case**: a page with no objection reads as advocacy, not analysis.
- **Scope creep**: a page that argues for the whole roadmap argues for nothing; one work item per page.
