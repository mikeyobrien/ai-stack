# Sidebar File Reader

A right-Sidebar tab type that opens workspace files as wrapped, line-numbered text.

The `editor` kind is an opt-in fallback candidate (`patterns: ['*']`), not the default file viewer.
The shipped document viewer wins by pattern specificity, retaining its previews and syntax highlighting.
Previously opened editor tabs retain their kind; close and reopen those tabs to use the default viewer.
The document preview toolbar contributes an **Edit** button for text files. It explicitly opens an
editor tab in edit mode, leaving the preview intact. After Save or Cancel, **Back to preview** reveals
the default viewer again. Navigation checks the mounted session to ignore stale-session callbacks.
Reading goes through `workspaceFiles`; writes use the version-guarded `sidebarEditor.save`.

## Scope of this version

- **Editing is wired end to end in code**: an Edit action swaps the reader for a textarea, Save calls
  `sidebarEditor.save` with the version the file was read at, and a stale save surfaces a conflict notice. The Client
  face is mounted by hand (`ctx.remote.$mount` with a `src-json` descriptor); if that mount fails the Edit action is
  disabled rather than broken.
- One page per open (5,000 lines); a longer file shows a truncation notice.
- Binary or unreadable files surface the Remote's error rather than pretending to render.

## Layout

| File | Purpose |
|---|---|
| `client.js` | The browser module: type definition, body, chip title |
| `index.js` | Host half: the `sidebarEditor` Remote service and its guarded write |
| `cordis.patch.yml` | Inserts the plugin row |
| `locale/en.json` | Bundle display metadata and the reader's copy |
| `icon.svg` | Artwork for the plugin manager |

## Status against the P0 plan

| Task | State |
|---|---|
| M0.1 scaffold + install | **done** — installed in the `web` profile, bundle row active, `pnpm` link in the profile |
| M0.2 test harness | **partial** — `node --test test/` runs 19 tests: module shape, type definition, session-scoped read, cache dedupe, remount without refetch, eviction bound, error mapping, note snapshot/formatting, per-session tray, descriptor shape, post-save cache update, the host's guarded write (version required, workspace containment, stale refusal), and the save-error mapping; no CI wiring yet |
| M1.3 tab type | **done** — `editor` kind, `extension` band, `dsh-resource://file/**` |
| M1.4 reader | **partial** — wrapped, line-numbered, scrollable; plain `<pre>`, not CodeMirror; no fullscreen control of its own |
| M1.1 document store | **done** — one entry per address, shared by every view, survives unmount, bounded LRU eviction |
| M1.2 caps/degrade | **partial** — one 5,000-line page with a truncation notice; binary and directory addresses now report their own copy instead of a wire error; still no hand-off to the preview |
| M1.5 chip title, M1.6 lifecycle, M1.7 entry point | not started |
| M2.0 note store + shared tray | **done** — panel writes, composer reads, per session |
| M2.1 anchor capture | **done** — line range + quote snapshot from a selection (no version/re-anchor yet) |
| M2.2 note composer | **done** — inline bar in the reader, Stage/Cancel |
| M2.3 staging control | **done** — `conversation.input.left` button; stages notes as draft text at the caret |
| M2.4 staleness / re-anchor | not started |
| M4.1 host Remote | **half done** — `sidebarEditor.save` with `replaceIfVersion`, mounted in the running harness |
| M4.2 containment | **done** — `fs.contains(root, target)` refuses a path outside the Session workspace |
| M4.3 edit UI + Client face | **done and verified live** — Edit/Save/Cancel, ⌘S/Esc, conflict copy, `$mount` with a hand-written strict-codec descriptor. Verified in headless Chromium against the running harness: the mounted method reached the Host, wrote through `replaceIfVersion`, and the file on disk changed |
| M2.5–M2.7 chat notes | **done** — select in the transcript, compose in the composer dock, stage through the same tray |
| M3 diff review, M5 | not started |

## How the Client face was verified

Two rules cost a round each, and both were found by running the real thing:

1. `$mount` rejects any input codec that is not `mode: 'strict'` — a `src-json` codec never mounts.
2. Cordis refuses `ctx.remote.<namespace>` unless the reading fiber injected it; after mounting, the
   namespace is read inside `ctx.inject(['remote.sidebarEditor'], …)`.

Verification ran headless Chromium (`chrome-headless-shell`) against the live GUI with a one-shot probe in
the composer: it read a file through `workspaceFiles`, saved it through `sidebarEditor.save`, and the file's
contents changed on disk — twice, before and after the envelope fix below. The probe is removed.

A Remote call resolves to an envelope (`{ok: true, value}`), not the business value; reading `result.after`
directly would treat every successful save as a failure. `unwrap()` handles it and is unit-tested.

## The Client face, and the rule that bites

`ctx.remote` installs one service per namespace from a contribution; there is no Proxy, and
`TypertRemoteRegistry.register` takes exactly `{package, descriptors}` — so a hand-written contribution is
accepted by contract, not by luck. `$mount` then validates: **every input parameter must carry a `mode: 'strict'` codec** — a `src-json` codec is rejected with
"has no strict codec" and the namespace never mounts. So the descriptor declares strict codecs whose `parse`
is JSON-identity (the real validation is host-side: version required, containment, staleness), and the result
uses the same shape. The Edit action stays disabled while `transport.save` is undefined, which is exactly the
state a failed mount leaves behind.

Editing keys inside the textarea: **⌘S / Ctrl+S** saves, **Esc** leaves edit mode without saving.

## Notes, end to end

1. Select code in the reader — a bar appears with the line range and a textarea.
2. **Stage for next message** files the note in a per-session tray; the reader returns to the file.
3. Staged notes are inserted automatically into the draft. A count chip remains only if insertion fails,
   allowing a manual retry. They are draft text, not native attachment objects.

Chat and preview selections use one compact `+ Add note` popover anchored beside the selected text.
Clicking it opens a quote preview and note field; Add (or Ctrl/Cmd+Enter) stages the note; Escape,
outside click, viewport resize, or scrolling outside the popover dismisses it. Chat captures stay
session-scoped and reject ranges spanning messages; preview captures read the address from the
preview's own `data-textpreview-url`, so they never depend on which tab is active.

Preview notes come in two shapes. A plain-text preview exposes `data-textpreview-line`, so the note
names a line range. A rendered preview (Markdown, HTML) has no source lines, so its note says
`selection in <path>` rather than inventing a range. The preview toolbar hosts this popover, so it
works in fullscreen, where the composer is not on screen. The editor's own inline note bar is unchanged.

Latest verification: 23 unit tests pass, including edge clamping/flipping and opt-in routing assertions.
The updated slot is active in the connected page. Actual popover appearance and built-in preview routing
have not been visually verified in this revision.

A note is a **snapshot**, not a live reference: the quote and the line range travel with it, so the message stays
correct if the file changes afterwards.

## Next

Editing, conflict handling and note chips follow the plan in `research/sidebar-editor-p0-tasks.md` (M1.2, M2, M3, M4).
