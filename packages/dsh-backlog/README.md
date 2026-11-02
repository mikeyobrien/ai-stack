# Session backlog

**Park now. Pull later. Never auto-send.** A lightweight DSH plugin for ideas that arrive while an agent is working. Capture does not use steering, the agent inbox, or the execution queue.

## Use

1. Refresh the existing GUI after installation. Click **Park** beside the composer.
2. Write an idea in the separate capture field. **Enter** saves; **Shift+Enter** adds a line; **Escape** closes without losing the unsaved text in this tab.
3. Open **Backlog · N**. It defaults to this session's held ideas; **Workspace** includes ideas from other sessions in the same workspace. The count is the workspace's held total.
4. **Pull into draft** inserts one idea plus its provenance at the last caret, without replacing selected text or existing draft content. It persists the draft but **does not send**. Review and send separately when ready.
5. **Edit** changes an idea. **Dismiss** hides it. **History** shows pulled and dismissed ideas; **Restore to backlog** returns an item to held. “Pulled” is not “completed.”

Capture is independent of the main composer and remains available while the agent runs. A failed save keeps the text and a retry ID. A refused draft insertion leaves the idea held. If insertion succeeds but updating its status fails, the UI retains a per-tab insertion receipt (also in session storage when available). **Mark pulled** retries only the status update, never inserts twice. A reload or list refresh does not discard that receipt.

## Install

This package belongs to the ai-stack npm workspace. From that workspace:

```sh
pnpm install
node --test packages/dsh-backlog/test/*.test.js
dsh plugin --profile web add "@local/dsh-backlog@link:$(pwd)/packages/dsh-backlog"
```

It is also included in the portable meta profile template installed by `./install.sh dsh`. Installation changes the selected profile for all its sessions. Refresh its existing URL after installation or client edits; this package does not start another web server and does not assume a development watcher is running.

## Storage and safety

- Fixed, workspace-local `.agents/backlog.json`, created on first save. Nothing is written merely by listing.
- Schema version 1; each item has `id`, `text`, `originSessionId`, `createdAt`, `updatedAt`, `state`, and `revision`. Timestamps are UTC ISO strings; UI dates use the browser's locale/time zone.
- JSON was chosen instead of the proposal's candidate Markdown checklist so multiline, arbitrary idea text round-trips unambiguously. You may edit valid JSON by hand; unsupported/corrupt data is rejected without overwrite. Do not delete fields or reuse IDs.
- Host filesystem reads and atomic writes use create-if-absent / replace-if-version guards. In-process workspace serialization prevents lost updates; bounded stale retries merge unrelated changes. Per-item revisions reject stale edits rather than clobbering them, including after a list refresh while editing. Pull checks the latest item before touching the draft. The supported concurrent-writer scope is clients/sessions on one running DSH host; the host filesystem guard is not a cross-process transaction. Do not have two independent DSH servers or external automation writing this file concurrently.
- Only a known session can resolve a workspace. The client cannot select a storage path. Symlinks/special files in the storage path and paths outside that workspace are refused.
- Limits: 20,000 characters per idea, 2,000 retained records, 2 MiB file. History is recoverable, not auto-deleted. Reaching a limit surfaces an error rather than silently pruning ideas.
- Backlog content is not automatically added to prompts or execution plans. It is an ordinary workspace file, not an access-control boundary: an agent explicitly reading workspace files can discover it. Add it to your local Git excludes if you do not want to commit personal ideas.
- Unsaved capture text is held only in this browser tab's plugin state. Saved records survive page refreshes and process restarts. The list refreshes on open, window focus, and **Refresh list**; it is not a real-time multi-client subscription.

## Components

- `store.js`: testable host operations, validation and guarded persistence.
- `index.js`: the `backlog.run` Remote service; no agent or message APIs.
- `client.js`: separate capture field, backlog controls and draft-only insertion, registered in the existing conversation slots.
- `test/backlog.test.js`: persistence, concurrent add, retry/idempotency, corruption, containment, recovery and no-submit tests.

No automatic execution, prioritization, dependencies, reminders, or new-session spawning is included in this version.
