# Global agent rules

These are defaults for work on this machine across all projects, on top of
applicable repository instructions. Follow the user's current request; keep
project-specific build, deployment, and architecture rules in that project's
`AGENTS.md`.

## Working style

- For browser automation or computer use, use the browser-learning skill to reuse and update verified operational recipes.
- Carry authorized work through implementation and appropriate verification.
  Resolve routine, reversible choices without repeatedly asking for permission.
- When a task depends on a prior decision, preference, or unfinished work—or
  when a wrong assumption would be costly—search memory for the specific point
  you need. If memory is inconclusive, check the most recent **relevant**
  session, not just the latest one. Use history to recover intent; verify
  current state before acting. If a consequential ambiguity remains, ask.
- Ask when missing information materially changes the outcome or an action could
  discard unique work. State the concrete decision that needs the user's input.
- Keep updates concise. Report what changed, what was verified, and any remaining
  limitations. Do not claim checks passed unless they actually ran.
- Prefer focused changes and existing project conventions. Run checks relevant
  to the change rather than adding unrelated refactors or process.
- Match the request: implement when asked to act; provide findings or
  recommendations when asked to review, explain, or suggest.
- Before ending a turn, check for promised actions that remain undone.
  Perform authorized actions now. If blocked, name the exact blocker
  and what is needed to proceed.
- Apply approval requirements to the specific action that needs approval.
  Complete authorized preparation and independent work first, then
  present a concrete result for approval. Preserve existing approval rules.
- Scale planning, research, and verification to the task's uncertainty
  and impact. Once relevant checks pass, finish. Broaden or repeat checks
  only when a change, failure, or unresolved concern justifies it.
- When an approach repeatedly fails, change strategy using the evidence.
  Avoid repeating equivalent attempts without a reason to expect a
  different result.
- Before claiming completion, compare the result with the requested
  deliverables. Distinguish completed work, verified results, assumptions,
  and anything still blocked. Keep that report brief.

## Decisions

- Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything.

## UI copy

- Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.
- If it needs to be explained, it isn't intuitive enough. Be conservative: add a tagline, helper text or secondary label only when you are highly confident it is needed, or when the user asks for it.

## Continuing

- A message of just `.` means continue with what you were doing last. Resume that work instead of asking what to do next.

## Delegating work

- Launch every delegated agent (including parallel reviewers, researchers, and nested workers) in its own labeled pane in the current Rex session's `Agents` tab. Use `~/Scripts/rex-delegate LABEL -- COMMAND [ARG ...]` from the intended working directory; for example, `~/Scripts/rex-delegate review -- pi 'Review the current diff; do not edit files.'`. Start a fresh agent session; pass its scope and the context it needs explicitly.
- The launcher prints the block ID. Keep it, check progress/results with `rex capture -s "$REX_SESSION" -b "$id" --trim`, and collect the worker's result before claiming completion. Leave its pane available for inspection. Ordinary tool calls in the parent are not delegations.
- Do not substitute hidden subagent tools, detached subprocesses, or agent-team modes that spawn invisible workers. If Rex or the target session is unavailable, work directly or report the blocker. Outside Rex, select an unambiguous session explicitly before launching.

## PR review payload

- When the user's message is `/review-diff [base]`, populate the PR Review panel: from the session workspace run `node ~/.dsh/im/pr-review-plugin/tools/review-diff.mjs [base]`, then author one commentary entry per hunk (`{ "hunk": <0-based>, "text": "why" }`) into the written `pr-review.json`. The web UI's PR Review panel (edge tab) renders that file; it and the Directions column refresh via the panel's ⟲/⟳ button or by running `/review-diff` again.

## Home directory layout

- Use `~/Projects/<name>` for new repositories and development projects.
- `~/projects` is a compatibility symlink to `~/Projects`.
  Resolve paths before counting checkouts; do not recreate it as a directory
  or clone another copy through the alias.
- Use `~/Scripts` for standalone scripts, `~/Documents` for documents,
  `~/Documents/Archives` for retained backups and cleanup records, and `~/Logs`
  for standalone logs when the application has no established log location.
- Keep temporary experiments and generated artifacts out of the home directory
  root. Use a project-local ignored directory or a suitable temporary directory.
- Existing service and runtime directories may intentionally live elsewhere.
  Inspect current processes, service definitions, and path references before
  relocating them. In particular, do not assume `~/dsh-workspace`, `~/voice`,
  `~/parakeet`, `~/lakandobo`, or `~/workspace` are disposable duplicates.
- Preserve compatibility symlinks until their callers have been migrated and
  verified. Do not reorganize tool-managed hidden directories as ordinary files.

## Repositories and cleanup

- Inspect status and applicable instructions before modifying a repository.
  Preserve unrelated edits, untracked files, stashes, and unique commits or tags.
- Use the repository's existing worktree workflow. Check registered worktrees
  and active processes before moving or removing a checkout.
- A matching repository name or remote does not prove a checkout is redundant.
  Compare history, local changes, ignored data, and runtime usage first.
- For cleanup, prefer recoverable moves to permanent deletion. Record original
  and destination paths under `~/Documents/Archives`; preserve Git metadata
  needed for recovery and verify worktree registrations afterward.
- Do not empty Trash or discard unfinished work as an incidental cleanup step.
- Keep credentials and private configuration out of logs, reports, and commits.
