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

- **Mine** — the prior art: what exists, what it assumed, and what failed.
- **Derive** — the choice from goals and constraints, not from the shortlist.
- **Align** — one page that leads with the recommendation and supports it in pyramid order.

The page itself carries:

- a governing thought that states the recommendation as an action;
- an SCQA opening that makes the recommendation feel inevitable;
- a key line of three to five arguments, the same kind of thing, in a deliberate order;
- evidence under each argument, only as much as the argument needs;
- action titles that carry the argument when read alone;
- one page, one decision.

It covers proposals, project kickoffs, design bets, and scope changes — anything where a reader must say yes, no, or "change this". It is not a status report, a spec, or a persuasion piece with no decision behind it. It assumes nothing is settled: stages 1 and 2 produce the decision, and stage 3 writes it.

## How

### Mine — build the evidence base

1. **Frame the question and the decision it feeds.** Write what you need to learn and who will act on it. A review without a decision becomes a link dump.
2. **Probe, then fan out.** List the likely sources — docs, reference implementations, adjacent ecosystems, papers, issues, post-mortems, benchmarks — and probe each briefly before a deep read. Extract per source: what it does, the constraints it assumes, what failed, what it costs, and when it was written.
3. **Rank skeptically, synthesize by approach.** Weight recency and fit over popularity, separate inherent constraints from inherited ones, and name the recurring patterns, dead ends, and gaps. Stop when new sources stop changing the answer.

For a broad or unfamiliar question, the prior-art skill expands this stage.

### Derive — build the choice

4. **Separate goals from means.** List the outcomes the decision must produce, rank must-haves against nice-to-haves, and say which wins when two criteria conflict.
5. **Decompose to primitives, then attack the frame.** Break the problem into constraints and quantities; mark each inherited or true. Invert it — "how would we guarantee failure?" — and check whether the real decision is upstream: scope, timing, ownership.
6. **Derive, evaluate, decide.** Generate options from the primitives, not the shortlist — including doing nothing and the smallest reversible probe. Score under uncertainty, test the assumption that dominates the spread, pre-mortem the leader, and state the recommendation with its confidence and the condition that would reverse it.

For a contested or hard-to-reverse choice, the first-principles skill expands this stage.

### Align — write the page

7. **Name the reader and the decision.** Write the one question the page must answer, who answers it, and what they should do after reading.
8. **Write the governing thought.** One sentence stating the recommendation as an action — "Adopt X for Y by Z", not "Considerations regarding X".
9. **Draft the key line.** List the three to five points that together prove the governing thought. Make them the same kind of thing and MECE: no overlap, nothing a skeptic would ask for is missing.
10. **Order the key line.** Pick one ordering and hold it: time, structure, or degree. Do not mix orders inside one group.
11. **Test vertical logic.** For each point, write the question it raises, then make the evidence beneath answer exactly that question.
12. **Write the SCQA opening.** Situation, complication, question, answer — three to five sentences, making the recommendation feel inevitable rather than displaying the work.
13. **Write action titles.** Every heading is a full sentence carrying its point. A reader who reads only the titles should get the argument.
14. **Fill the evidence, then cut to one page.** Add only what each argument needs, then cut repeated context, background the reader already has, and every option you are not recommending. Aim for 400–600 words.
15. **Red-team the page.** Read as a skeptic: which claim is unsupported, which number is stale, which objection is missing? Add the strongest counter-case and the reversal condition, then confirm the order is conclusion, reasons, detail.

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
- **Research theater**: mining past the point where new sources stop changing the answer.
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
