---
name: one-pager
description: "Use when aligning on a new work item — drafting the one-page narrative that leads with the recommendation and supports it in pyramid order. Turns a scattered proposal into a page a reader can approve in one pass."
---

# One-Pager

## Why

A work item usually reaches the reader as a pile: context, options, caveats, and the conclusion near the bottom. The reader has to reconstruct the point before they can judge it, and most will not. Barbara Minto's pyramid principle fixes the order of that reconstruction — conclusion first, supporting arguments grouped beneath it, evidence under each argument, and every level answering the question the level above raises. Written that way, a single page gets read once and decided.

## What

A standalone method for drafting a one-page narrative that aligns a reader on a new work item:

- a governing thought that states the recommendation as an action;
- an SCQA opening that makes the recommendation feel inevitable;
- a key line of three to five arguments, the same kind of thing, in a deliberate order;
- evidence under each argument, only as much as the argument needs;
- action titles that carry the argument when read alone;
- one page, one decision.

It covers proposals, project kickoffs, design bets, and scope changes — anything where a reader must say yes, no, or "change this". It is not a status report, a spec, or a persuasion piece with no decision behind it. It assumes the decision and its owner are already known; if they are not, settle those first.

## How

1. **Name the decision and the reader.** Write the one question the page must answer, who answers it, and what they should do after reading. A page that serves two audiences serves neither.
2. **Write the governing thought.** One sentence stating the recommendation as an action the reader can take — "Adopt X for Y by Z", not "Considerations regarding X". If the sentence will not form, the thinking is not finished; go back to the work item.
3. **Draft the key line.** List the three to five points that together prove the governing thought. Make them the same kind of thing — all reasons, all steps, all risks — and check they are MECE: no overlap, and nothing a skeptic would ask for is missing.
4. **Order the key line.** Pick one ordering and hold it: time (sequence), structure (parts of a whole), or degree (most to least important). Do not mix orders inside one group.
5. **Test vertical logic.** For each key-line point, write the question it raises in the reader's mind, then make the evidence beneath answer exactly that question. A point that raises no question is decoration; evidence that answers a different question means the point is wrong.
6. **Write the SCQA opening.** Situation: context the reader already accepts. Complication: what changed, or what is now at stake. Question: the question the complication forces. Answer: the governing thought. Keep it to three to five sentences; its job is to make the recommendation feel inevitable, not to display the work.
7. **Write action titles.** Every heading is a full sentence carrying its point — "Migrating now costs two weeks and removes the outage risk", not "Migration". A reader who reads only the titles should still get the argument.
8. **Fill the evidence, then cut to one page.** Under each argument add only the facts, numbers, and links that argument needs. Then cut: repeated context, background the reader already has, and every option you are not recommending. Aim for 400–600 words.
9. **Red-team the page.** Read it as a skeptic: which claim is unsupported, which number is stale, which objection is missing? Add the strongest counter-case and the condition that would reverse the recommendation. Then read top-down and confirm the order is conclusion, reasons, detail.

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
- Is the governing thought an action or a topic?
- Are the key-line points the same kind of thing, and do they cover the whole case?
- What order are they in, and is that the order the reader needs?
- What question does each point raise, and does the evidence answer it?
- Which claim would a skeptic attack first, and where is its support?
- What would reverse the recommendation, and is that stated?
- What can be cut without weakening the argument?
- Does the page still work if the reader only reads the titles?

### Gotchas

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
