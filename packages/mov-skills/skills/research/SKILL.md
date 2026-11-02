---
name: research
description: "Use when a question needs evidence gathered from many sources and no decision hangs on it yet — splits the reading across subagents, keeps every source link, and files one cited report where the repository expects it."
---

# Research

## Why

A question with no decision attached still needs an answer that can be checked
later. One agent reading twenty sources in one context keeps the first and the
last and loses the middle, and whatever it keeps is unlinkable: a claim with no
source cannot be argued with, only repeated. Research fails in two directions —
reading too little and concluding, or reading widely and filing nothing — and
both end the same way, with a summary nobody can trace.

## What

A fan-out read that ends in one written, cited artifact:

- a question phrased so a source can confirm or contradict it;
- independent slices of the reading, handed to separate agents in parallel;
- one extraction template per source, so the results merge without a second pass;
- the raw material kept beside the report, not only summarized;
- a synthesis written by theme rather than by source;
- an explicit gap list: what could not be found, and what would settle it.

It covers open questions — what exists, how something behaves, what happened in a
similar case. It stops where a decision starts: for an evidence base built to
weigh a choice, use `prior-art`, which ranks and judges as well as gathers.

## How

1. **Phrase the question so it can fail.** "Postgres LISTEN/NOTIFY limits" is a
   topic. "Does LISTEN/NOTIFY pay one delivery per connection, and where does the
   documentation say so?" is a question an answer can contradict.
2. **Split the reading into independent slices.** By source type, ecosystem, or
   sub-topic — whatever makes the slices disjoint. Every slice gets the same
   extraction template, or you pay for a merge pass later.
3. **Launch the slices together.** Independent delegations started in one turn
   run concurrently. Tell each one what to return: source, date, version, the
   claim it supports, and the constraint the source assumed.
4. **Keep the raw material.** Fetch the pages, commit excerpts, or save the
   command output into `sources/` beside the report. A link rots; a saved excerpt
   with its date does not. Never store a claim whose source you did not read.
5. **Separate evidence from inference.** The template has a slot for what the
   source says and a slot for what you think it means. Blurring them is how a
   report ends up asserting something no source claimed.
6. **Synthesize by theme.** Group what was found into recurring patterns,
   disagreements, and gaps — not one paragraph per source. Combining sources is
   where a new answer appears; listing them is not a report.
7. **File it where the repository puts run artifacts.**
   `.agents/scratch/<YYYY-MM-DD>-<slug>/report.md`, with `sources/` beside it.
   Defer to a stricter repo convention when one exists.
8. **Say what is unverified.** Every report ends with the gaps: what was not
   found, which sources were stale, and what would change the answer. A report
   that reads as complete and isn't is worse than one that admits its edges.

### Gotchas

- **Link dumping.** A list of URLs is an index, not a synthesis. If the report
  would survive deleting every paragraph, it was never written.
- **Single-source claims.** One blog post is a hypothesis. Look for a second,
  independent source before a fact goes in the report.
- **Recency blindness.** Date every source and prefer current versions for
  fast-moving topics; a 2019 answer to a 2026 question is a trap, not precedent.
- **Survivorship bias.** Failures are underreported. "No write-up" is not
  evidence that something works.
- **Unfiled scratch.** Research left in a context window is lost the moment the
  conversation ends, and the next agent redoes it. Write the file.
- **The question mutating mid-read.** If the slices keep returning answers to
  slightly different questions, stop and re-phrase once rather than merging noise.
- **Confidence inflation.** Three sources agreeing because they copied each other
  are one source. Say so when you cannot tell.
