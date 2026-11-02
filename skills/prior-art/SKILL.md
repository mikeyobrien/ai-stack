---
name: prior-art
description: "Use when researching prior art — implementations, papers, post-mortems, or benchmarks — to build an evidence base for a design or decision. Mines, ranks, and synthesizes what already exists, including what failed."
---

# Prior Art

## Why

Most problems have been attempted before. The work is scattered across repositories, papers, issue threads, and post-mortems, and the useful part is rarely the headline: it is the constraint someone hit, the approach that failed, and the version that aged out. Skipping that work produces reinvention; copying it without checking produces cargo cults. This skill turns scattered precedent into an evidence base you can reason from.

## What

A standalone method for mining existing implementations and research into a decision-ready evidence base:

- sources identified and probed before deep reading;
- fan-out across sources and sub-topics;
- ranked on recency, reputation, popularity, and fit;
- evidence separated from claim, with links and versions;
- a report that ends in recommendations and open questions.

It covers code, papers, post-mortems, docs, issues, and benchmarks. It does not decide: it supplies the base rates and candidate constraints that a decision method can test, and neither skill requires the other. It is not for questions answerable from the repo, a spec, or a single document.

## How

1. **Frame the question and the decision it feeds.** Write what you need to learn, who will use it, and what choice it informs. A prior-art review without a decision becomes a link dump.
2. **Identify sources and probe.** List the likely sources: official docs, reference implementations, adjacent ecosystems, papers, issue trackers, post-mortems, benchmarks. Probe each briefly before committing to a deep read.
3. **Fan out.** Split the work by source and sub-topic; run parallel workers when available. Give each the same extraction template so the results merge without a second pass.
4. **Extract per source.** Record what it does, the constraints it assumes, the option it chose, what failed, what it costs, and its license and maintenance status. Quote or link the evidence and date it.
5. **Rank skeptically.** Weight recency heavily for AI topics, weigh maintainer reputation and adoption, and discount popularity when it is novelty-driven. Check whether the source's constraints match the problem before treating it as precedent.
6. **Synthesize by approach, not by source.** Name the recurring patterns, the disagreements, the dead ends, and the gaps nobody covered. Combining implementations is often where a genuinely new option appears.
7. **Stress-test the evidence.** Look for disconfirming cases, unpublished failures, and survivorship bias. Separate constraints that are inherent to the problem from those inherited from one team's context.
8. **Report.** Lead with the answer: the shortlist, the recommended pattern, the quality of the evidence, and what still needs verification. Include a source table with links, dates, versions, and licenses.

### Questions

- What has been tried, and what happened?
- Which constraints did those implementations assume, and do they hold here?
- Where do sources disagree, and why?
- What is missing from every source?
- Which source is current, and at what version or commit?
- Is adoption real, or novelty-driven?
- What failed that was never written up?
- What would make us not copy this?

### Gotchas

- **Recency**: AI material ages fast; date every source and prefer current versions.
- **Cargo culting**: popularity is not fit; check the constraints behind the pattern.
- **Link dumping**: a list without synthesis is not a review.
- **Single-source bias**: one blog post or one repository is not prior art.
- **Survivorship bias**: failures are underreported; absence of a write-up is not evidence of success.
- **License blindness**: copying code without checking its license creates a liability.
- **Stale constraints**: a pattern from a different scale, team, or era does not transfer for free.
- **False novelty**: combining sources can produce an option that is a known failure with a new name.
