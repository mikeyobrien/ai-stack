---
name: delegate
description: "Use when handing a self-contained piece of work to another agent — deciding what can be cut loose, writing the brief it needs without this conversation, verifying the result, and knowing when a task is too entangled to hand off."
---

# Delegate

## Why

Delegation looks free and is not. A child agent does not share this conversation
unless it was forked, so every fact it needs must be written down; a brief that
says "fix the bug" returns a plausible patch against the wrong repro. The
expensive failures are quiet ones: a child reports success, the parent passes it
on, and nobody ran the check. The work of delegating is mostly the brief and the
verification, not the handoff.

## What

A method for moving one bounded piece of work to another agent and getting a
result you can stand behind:

- a test of whether the task should be delegated at all;
- a choice of backend — fresh context, forked context, or a different provider —
  matched to what the task needs;
- a brief that stands alone: goal, constraints, inputs, acceptance check, and the
  shape of the answer;
- a verification pass the parent performs itself;
- a decision about what to do when the result is close but wrong.

It covers research, scoped implementation, review, and fan-out reading. It does
not cover work that only makes sense inside this conversation, and it does not
replace doing a small task yourself.

## How

1. **Decide whether it should leave.** Delegate when the task is self-contained,
   needs more reading than it needs judgement, or can run while you do something
   else. Keep it when it depends on what was just said, when the answer must be
   consistent with decisions still in flux, or when writing the brief would take
   longer than the task. A one-file edit is not a delegation.
2. **Check the entanglement.** Ask what the child could get wrong that you would
   only notice after it finished. If the answer is "the whole premise", the task
   is not self-contained yet — split it until it is, or keep it.
3. **Pick the backend.** A fresh subagent gets a clean context and needs
   everything in the brief. A forked subagent inherits the conversation and is
   right for follow-ups and reviews of work already done here. An external
   provider is worth it when the task suits a different model or needs its own
   toolchain; it takes no follow-up messages, so the brief must be complete the
   first time.
4. **Write the brief as if the reader has never seen this repository.** State the
   goal in one sentence, the constraints that actually bind, the files or
   commands that matter, the acceptance check the parent will run, what to
   return (a diff, a file path, a short answer), and what not to touch. Include
   repo conventions; omit secrets and personal paths.
5. **Launch independent work together.** Two independent delegations started in
   one turn run concurrently; started one after another they serialize. Do not
   duplicate a child's work while it runs — that is what the idle time is for.
6. **Verify rather than accept.** Run the acceptance check yourself: read the
   diff, execute the test, open the page. A child reporting "done" is a claim,
   and the parent is the one who signs it.
7. **Close the loop.** Steer a running child with a message when the direction is
   wrong; interrupt it when the premise is wrong. If the result is 80% right,
   decide explicitly between asking for the remainder and finishing it here —
   silently patching a delegated result teaches nothing about the next brief.

### Gotchas

- **Brief by reference.** "The file we discussed" means nothing to a fresh
  context; every reference must be a path, a command, or a quoted line.
- **A success claim as evidence.** The most common failure is a child that says
  it worked and a parent that believes it. Verify before reporting.
- **Concurrent writers.** Two children editing the same files produce a merge
  nobody reviewed. Partition by file or run them in sequence.
- **The wrong context.** Forking a long conversation for a task that only needs
  the spec carries every assumption in the parent, including the stale ones.
- **Delegating the judgement.** A child can gather, draft, and check; it cannot
  decide what the result is worth. That stays with the delegator.
- **No follow-up by design.** Some backends cannot be continued after they
  finish, so a brief that ends with "and then we will iterate" is not a plan.
- **Silent scope.** A child asked to fix one thing may fix three. Name what must
  not change, and check the diff for exactly that.
