---
name: "guard-the-context-window"
description: "Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads."
source: "https://github.com/cursor/plugins/blob/f713f14203cd6420cec13cd7c55c32d598dbab68/pstack/skills/principle-guard-the-context-window/SKILL.md"
license: "MIT, Copyright (c) 2026 Lauren Tan. Full text: LICENSE-pstack.txt"
---

# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress. The cost is paid twice — once in tokens, and again when a compaction discards the detail the task still needed.

Extended from the pstack principle of the same name (MIT, © Lauren Tan); the upstream text ends after the first item.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
- **Read narrow, not whole.** Ask for the line range, the symbol, or the match, not the file. Grep before read; read with offset and limit after.
- **Route bulk to a child.** A subagent that reads twenty files and returns ten lines costs the parent ten lines. Keep the fan-out in the child and the conclusion in the thread.
- **Keep summaries, not payloads.** The main thread holds decisions and evidence. Raw output goes to a file whose path you keep, not into the conversation.
- **Bound every command's output.** Head, tail, count, or a filter. An unbounded dump is a context decision made by accident.
- **Merge once.** Parallel slices with one shared extraction template, then a single synthesis, rather than N sequential full reads.
- **Watch for the signals.** Repeating a read you already did, re-deriving a fact you already wrote down, or pasting the same block twice means the window is already the problem.
