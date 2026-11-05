# Workspace awareness acceptance and verification

## Acceptance checks (recorded before implementation)

1. As the sidebar Agent, I receive every currently registered workspace's stable ID, display name, and absolute directory in my turn context, so I can answer “what workspaces are you aware of?” without browser or configuration lookups. Include remote/host identity only if the registry actually provides it.
2. When an isolated registry fixture adds, renames, or removes a workspace, my next Agent turn receives the new directory with no stale rows in the current snapshot. Never mutate the user's registry for verification.
3. As an ordinary project session or a delegation, I retain my existing context without the sidebar-only broad workspace directory.
4. I retain existing runtime context fields, session/workspace isolation, delegation tools/reports, and sidebar chat behavior. The directory contains identities only, not histories, project files, instructions from other workspaces, or secrets. Workspace strings are data, not instructions, and awareness grants no action permission.
5. Repeated turns contain exactly one directory contribution per current snapshot. Unchanged snapshots are deduplicated by the existing runtime-context projection; changed snapshots follow its existing latest-snapshot contract, without a second injection pipeline.

## Regression contract

Preserve current working directory, file policy, implementation location, GUI URL, model selection, scoped prompt/tool composition, ordinary sessions and delegation lifecycle. Preserve unrelated uncommitted work. Do not restart the live backend, replace the server, or modify the real workspace registry for tests.

## Extension point

Use the existing `systemPrompt.context` registry on the always-on Agent's scoped context, alongside its existing scoped prompt/tools. Its provider is evaluated at assembly and request admission; the loop already forms and deduplicates `runtime-context` snapshots. Changed snapshots append under the existing “supersedes earlier snapshots” contract rather than removing historical events.

## Evidence

### Live entry point

At `2026-11-03T15:58:09.555Z`, the existing GUI URL returned an online, idle Agent after a read-only question sent through the Agent composer. Asked to use only its current runtime context and call no tools, it answered with eight `{id,title,path}` records: the original six plus two Ralph verification workspaces added by other work. Ungrouped was absent. The observed verification turn contained only a user message and an assistant message, zero tool rows. The question did not ask the Agent to resume or endorse this implementation.

The filtered status evidence is saved at [live workspace answer](<../../.playwright-mcp/sidebar-workspace-awareness-live.json>). This proves the live answer path; exact generated input and fixture verification are recorded separately below.

**Full live raw-input end-to-end verification: unverified.** A targeted `session_event_search` for the sidebar Agent's runtime snapshot was rejected with `session target is outside the caller workspace`. This project/delegation session cannot inspect the sidebar account's events. No raw-log or alternate-API workaround was used. An owner-context reviewer can inspect its latest `runtime-context` event to close that boundary. The live answer is observed, not inferred; it does not substitute for raw input inspection.

### Deployment

The only production-code change is the local Host plugin's JavaScript; no client/shell/core artifacts need rebuilding. The selected profile already symlinks this package. No `pnpm run dev:web` watcher was running; browser HMR was not relied upon. This task did not restart or reload the backend. Another session independently restarted it at `2026-11-03 09:54:27 CST` (PID changed from `1036602` to `1464996`), after the source edit. The existing page was then refreshed, and the live answer above verified the feature rather than inferring activation from the restart.

For future Host-only source updates, use authorized targeted Host plugin reconciliation when the sidebar Agent and its delegations are idle; unloading the plugin can dispose work it owns. Do not restart an active backend merely to load this change.

### Focused tests and generated input

Independent final run from the ai-stack root:

```sh
DSH_SIDEBAR_CONTEXT_PROOF=/home/mobrienv/dsh-workspace/ai-stack/.playwright-mcp/sidebar-workspace-turn-input.json node --test packages/dsh-sidebar-agent/test/
node --check packages/dsh-sidebar-agent/index.js
node --check packages/dsh-sidebar-agent/test/workspace-context.test.mjs
git diff --check
```

All exited successfully: **14/14 tests passed**, including five new integration tests (311.9 ms total suite). Syntax and tracked-diff whitespace checks passed. The sidebar package was already untracked at task start; the production change was reviewed directly at the edited composition block, not inferred from an empty tracked diff. No staging, commits, resets, or unrelated edits were performed.

The tests exercise the exported plugin `apply`, Remote chat service, real Cordis scopes, SystemPrompt, AgentLoop, SessionStore/projection, tools, WorkspaceRegistry with JSON storage, and temporary JSONL session persistence. Inference is substituted with a capturing LLM adapter; file policy/checkout/GUI values are fixture providers, and unrelated upload/full-text/interactive capabilities fail fast. They do not exercise the production model or permission-policy implementation. All registry changes occur in isolated temporary directories, never the user's registry.

The [actual captured requests](<../../.playwright-mcp/sidebar-workspace-turn-input.json>) were directly inspected: [initial snapshot](<../../.playwright-mcp/sidebar-workspace-turn-input.json#L32-L67>), [renamed directory](<../../.playwright-mcp/sidebar-workspace-turn-input.json#L1524-L1559>), [removed row](<../../.playwright-mcp/sidebar-workspace-turn-input.json#L2048-L2083>), and [empty directory after removal](<../../.playwright-mcp/sidebar-workspace-turn-input.json#L2636-L2671>). These are actual model-boundary requests from the real injection path in the isolated harness, not manually assembled expected prompts.

| Acceptance check | Observed evidence |
|---|---|
| 1. Direct workspace awareness | Real plugin chat reaches inference with all fixture IDs/titles/absolute paths; live Agent answers eight current workspace rows without any tool calls. Raw live input remains inaccessible as noted above. |
| 2. Next-turn freshness | Real isolated registry create, `setTitle`, and delete are reflected on subsequent chat turns; removal leaves no stale rows in the current snapshot. A rename after assembly is also refreshed at admission. |
| 3. Ordinary-session isolation | Ordinary project and real tool-driven delegation requests lack the broad directory and sidebar delegation tools, while retaining their own cwd/runtime fields. |
| 4. Regressions and leakage | Existing nine tests pass. New tests preserve cwd/policy/checkout/GUI fields, model route, workspace attachment, delegation tool/report and chat behavior. Literal template/newline/quote values survive; only id/title/path appear despite real source metadata and another session's history/project instructions. Missing-path registration and invalid chat reject without changing the current context/request count. |
| 5. Snapshot contract | Current snapshot contains one directory section. Snapshot counts across empty/add/unchanged/add/rename/remove/clear are `1,2,2,3,4,5,6`; unchanged turns retain the same message identity. Earlier snapshots remain historical under the existing superseding contract. |

### Scaling and remaining limitations

No new size cap, discovery tool, cache, or context pipeline was added. The registry's synchronous `list()` returns current in-memory entities without persistence reads. Directory serialization is linear in registered workspace count; no constraint was encountered at the observed eight-workspace scale. Changed runtime snapshots remain in history under the established contract, so frequent mutations retain historical snapshots; unchanged turns add none. Workspace records do not support host/remote metadata, so none is invented.

Full live raw-input inspection remains the sole named verification gap. Future parent/owner-context inspection can close it without modifying the registry or restarting the service.

# Chat UI/UX delivery — 2026-11-03

## Acceptance checks (written before the implementation)

1. I can tell my messages, assistant answers, execution activity, and delegation reports apart at a glance, without author labels, avatars, or helper text.
2. I can read headings, lists, tables, links, inline code, fenced code, and long content at a comfortable measure; code and tables scroll inside themselves, not the whole page.
3. Consecutive execution calls collapse into one restrained disclosure with human labels and a visible failure count; expanding it preserves order and exposes result details, never raw arguments in the collapsed line.
4. A delegation report is a compact, attributed disclosure (title, workspace, outcome); expanding it shows the report, rendered safely, not a duplicate wall of chat text.
5. Model and thinking selection sit next to the composer; the header is identity/progress only. At 390 px and 320 px the control row fits without clipping, and Send/Stop stay reachable.
6. Enter sends, Shift+Enter inserts a newline, and Enter during IME composition never submits.
7. A failed send or a stop keeps the draft and attachments.
8. Reading earlier turns is not interrupted; a clear Latest control returns to the newest turn, and expanding activity above the reader does not move the sentence being read.
9. Running, stopped, idle, loading, empty, and error states are understandable, with status announced without announcing every streamed token.
10. In the sidebar, a running delegated session shows a visible spinner in a contrasting accent distinct from the completed state, in light and dark themes; unrelated session spinners are unchanged.
11. Every interactive control is keyboard reachable with a visible focus ring and an accessible name.
12. A very long expanded delegation report or activity body does not take over the conversation: its body scrolls internally within a responsive cap, the title/badge/collapse control stay outside that scroller, wheel and keyboard reach the final content, and the main transcript stays where I was reading.
13. Assistant prose, lists, tables, and code use the panel's readable scale (14–16 px body, not the shell's 10 px content default), so they do not look tiny beside user bubbles.
14. I can paste a PNG/JPEG/WebP/GIF image into the Agent composer and see the same removable attachment preview the file picker produces; my draft and existing attachments stay, identical clipboard images attach once, text/multiline paste is unchanged, and an oversized or unsupported image shows an actionable attachment error without clearing anything.

## Regression contract

Persistent Agent/session identity, runtime and workspace injection, delegation/report delivery, model and thinking selection, attachment upload/removal, live streaming, steering while running, stop, errors/drafts, ordinary DSH sessions, and unrelated plugins. No global renderer, router, or command parser was replaced. Slash commands remain unavailable (named limitation below).

## Observed evidence

### Live app — https://columba.whydah-theropod.ts.net/

The parent's rerunnable read-only verifier (`verify-agent-live.js`) was run after implementation at 1280, 390, and 320 px in both schemes. It reported for every sample: `pageFits: true`, `regionFits: true`, `composerVisible: true`, `offscreenButtons: []`, `textOverflowingButtons: []`, `hasTranscriptLog: true`, `hasLiveStatus: true`. Semantic Markdown in the retained transcript on the final run: 2 tables, 1 list, 1 code block; an expanded report added its own table and list. The 320 px sample kept Stop on screen (right edge 308 of 320) and the composer bounded. Screenshots: `/home/mobrienv/.dsh/sidebar-agent/workspace/agent-after-final-1280-light.png`, `agent-after-final-1280-dark.png`, `agent-after-final-390-light.png`, `agent-after-final-390-dark.png`, `agent-after-final-320-dark.png`; typography pass: `agent-after-typography-1280-light.png`, `agent-after-typography-1280-dark.png`, `agent-after-typography-390-light.png`, `agent-after-typography-390-dark.png`, `agent-after-typography-320-dark.png`. Before: `agent-before-desktop.png`, `agent-before-mobile.png`, `agent-baseline-1280-dark.png`, `agent-baseline-390-light.png`, `agent-baseline-320-dark.png` (Stop offscreen). All were opened and inspected.

- Markdown: an expanded delegation report rendered `H3 Changes`, `H3 Verification`, one table, and one list inside `.sa-reportBody`; the table wrapper reported `overflow-x: auto` and the page did not overflow. The visible transcript rendered bullets, strong, inline code, links, and a fenced block through the platform `MarkdownText` primitive; no homegrown Markdown parser remains.
- Readability integration: the panel was inheriting the shell body's `--dsh-content-font-size: 10px`, so the shared Markdown renderer computed 10 px/20 px paragraphs while the panel and user bubbles were 14 px. The panel now sets its own content tokens (`--dsh-content-font-size`, delta, code size, and the shared `--dsw-font-markdown-*` shorthands) on the panel root; no renderer CSS was replaced. Live computed values: desktop paragraphs/lists 14 px/24 px, tables 13 px/22 px, code 12 px/19 px, user bubbles 14 px; at 390/320 paragraphs/lists 16 px/26 px, tables 14 px/23 px, code 13 px/20 px, user bubbles 16 px. The rerunnable `.playwright-mcp/verify-agent-typography.js` returned `pass: true` for all four samples; screenshots `.playwright-mcp/sa-typography-1280-light.png`, `sa-typography-1280-dark.png`, `sa-typography-390-light.png`, `sa-typography-320-dark.png` were inspected.
- Capped report/activity bodies: the live longest report ("Trace duplicate notifications and leaked goal markup") had body `scrollHeight` 5934 against `clientHeight` 400 (cap 400) at 1280×800, 11837 against 422 at 390×844, and 14977 against 360 at 320×720. The expanded activity "Browser tabs +24 2 failed" measured 748 against 400. Every body reported `overflow-y: auto`, `overscroll-behavior-y: contain`, `role="region"`, `tabIndex=0`, with the title/badge/collapse header outside the scroller. A tool result detail keeps its 200 px cap and gained the same region semantics. A live keyboard run on the longest report focused the region by Tab (solid outline), pressed `End`, and reached `scrollTop 5534/5534`; the final content bottom was 682.5 inside the body bottom 691 and transcript bottom 691, while the transcript stayed at 4058. Screenshots: `.playwright-mcp/sa-typography-1280-light.png`, `sa-report-capped-keyboard-1280.png`, `sa-activity-cap-1280-light.png`, `.playwright-mcp/fixture-long-report-390.png`.
- Clipboard image paste: the isolated fixture dispatches real `ClipboardEvent` / `DataTransfer` / `File` objects through the textarea and the actual `AgentChat` component against the fake `chat` remote. Verified: an image-only paste produces a `pasted.png` chip with the draft untouched and enables an image-only send whose request contains one `image/png` file with data; removal clears the chip and re-disables Send; an existing text attachment plus a pasted image leaves both chips and the draft; two identical images produce one chip while two distinct PNG/GIF images produce two; a text-only paste is not prevented and creates no attachment; image+text is not prevented (the browser keeps the text) while the image attaches; an `image/tiff` paste and a 10 MB+1 paste both show the actionable error and leave the draft and chips unchanged. A live smoke paste into the real composer with a synthetic `ClipboardEvent`/`DataTransfer`/`File` was also run without submitting: `defaultPrevented` was true, the removable `paste-preview.png` chip appeared, the draft stayed empty, and removing the chip returned the composer to zero chips with the draft unchanged (`restored: true`). Screenshot: `.playwright-mcp/sa-live-paste-preview.png`. No image was sent to the live Agent; the parent can independently repeat the paste→preview check read-only.
- Activity: the live transcript showed more than a dozen collapsed groups; headers read as human phrases with counts and failure counts ("Found **/AGENTS.md +18 1 failed", "Ran pwd +27", "Delegated +9") and contained no `{`, `}`, `mcp__`, or quote-delimited JSON. Expanding one group produced 19 `.sa-toolItem` rows with per-row result buttons and a visible `Failed` label.
- Reports: the live delegation reports rendered as compact rows (title, `Done` badge, chevron) with no `.sa-userBubble`; expanding showed workspace, session id, and rendered body.
- Delegated spinner: with two delegated and two ordinary sessions running in the same list, the delegated rows measured `rgb(65, 118, 230)` (`#4176e6`) in light and `rgb(122, 170, 255)` (`#7aaaff`) in dark; the ordinary running rows stayed `rgb(129, 133, 140)` (`#81858c`) in light and `rgb(173, 178, 184)` (`#adb2b8`) in dark. A completed row in the same list used the green success dot, visibly distinct from the blue spinner. The idle delegated row still shows the share glyph with accessible name "Delegated session", and the running rows keep their visually hidden "Running" label. Side-by-side screenshots: `.playwright-mcp/sa-spinner-contrast-light.png`, `sa-spinner-contrast-dark.png`, plus element crops `sa-delegated-row-light.png`, `sa-delegated-row-dark.png`, `sa-ordinary-row-light.png`. The accent rule is scoped to `[data-row-key="session:<delegated-id>"] svg[data-state="ongoing"]`; no other row is targeted.
- Scroll: with the live transcript scrolled 900 px from the bottom, it stayed there across polling updates and a `Latest` control appeared; activating it returned to distance 0 and moved focus to the composer. Reduced motion was honored (instant jump).
- Composer: at 320 px the control row measured model 68–149, thinking 155–203, Stop 267–308; input 120–246 and Send 254–308. At 320 px the model menu was 240 px wide from x=68 (right 308) and stayed inside the viewport; at 1280 px its left edge aligned with the model control (both x=450) and at 320 px with the same control (both x=68).

### Isolated browser fixture — no host, no live Agent

`node --test packages/dsh-sidebar-agent/test/fixture.test.mjs` rendered the real client module against a fake transport with React 18 UMD and a stub `MarkdownText` (the platform renderer is verified live instead). The fixture suite passed (fifteen focused subtests; sixteen test results including the outer test):

- empty/loading/error states; Enter sends and clears on success; Shift+Enter inserts a newline; composition start and keyCode 229 do not submit; Enter after composition end does;
- failed send keeps the draft, attachment, and error; remove works; Stop calls stop and keeps the draft; the header then reads `Stopped`;
- three consecutive calls become one group with no raw JSON; reports are `.sa-report`, not `.sa-userBubble`;
- scrolling up freezes the position, new content does not pull the reader down, `Latest` returns to distance ≤ 2 and focuses the composer;
- expanding an activity group above the reader keeps the visible turn's top within 2 px (native scroll anchoring, no manual compensation remains);
- long report bodies cap at `min(50dvh, 28rem)` (desktop 400, 390 422, 320 360), scroll internally, expose a named focused region, reach the end by wheel and keyboard without moving the transcript, and collapse with the header outside the scroller;
- long activity bodies cap, expose the same region semantics, and a long nested tool result stays bounded at 200 px;
- clipboard image paste reuses the attachment pipeline, preserves draft/existing attachments, deduplicates identical images, leaves text-only paste native, rejects unsupported/oversized images with an error and no draft loss, and sends image-only content through the mocked remote;
- the model menu is bounded, focuses its menu, closes on Escape, returns focus to the trigger, and selecting a model calls `setModel` once;
- `role="log"`, `role="status"`, accessible names, and the 320 px no-offscreen/no-overflow gate.

## Tests and checks

```sh
node --test packages/dsh-sidebar-agent/test/
# 42 tests passed, 0 failed (includes 16 fixture test results / 15 focused subtests)
node --check packages/dsh-sidebar-agent/client.js
node --check packages/dsh-sidebar-agent/index.js
node --check packages/dsh-sidebar-agent/test/client.test.mjs
node --check packages/dsh-sidebar-agent/test/fixture.test.mjs
node --check packages/dsh-sidebar-agent/test/fixture/fixture.js
node --check packages/dsh-sidebar-agent/test/fixture/server.mjs
git diff --check
```

The fixture requires React UMD outside the plugin (setup in README) and skips when it is absent.

## Deployment and reload

Changed artifact: `packages/dsh-sidebar-agent/client.js` (the hand-written client bundle served through the profile symlink) plus tests/docs. No host change was needed. No `dev:web` watcher was observed. The client-plugin HMR receiver picked up each edit: the panel remounted and the new placeholder, CSS, and control row appeared in the existing URL with no backend restart and no replacement server. The live checks above were taken after those reloads. The page was also fully reloaded and re-opened to verify the final artifact. No model selection, attachment, session history, or workspace registry was changed for testing; no test message was sent to the live Agent.

## Remaining limits

- **Slash commands are not available in the Agent panel.** The panel sends through the `agent` Remote and does not own a browser-retained ordinary session; the shared command registry is session-scoped. Wiring it here would bind commands to the wrong session, and no parallel parser was added. Model/thinking, attachments, steering, stop, and the shell's global shortcuts are preserved.
- The live transcript has no rendered headings while reports are collapsed; headings were verified by expanding a report.
- Screen-reader announcement cadence is implemented as `role="log"` (announcing off) plus a polite `role="status"` for running/stopped/reply-complete. It was not tested with a real screen reader.
- The isolated fixture substitutes a `MarkdownText` stub; Markdown hierarchy and table scrolling were verified only in the live app.
- Real failed-send and stop behavior was verified in the isolated fixture; forcing them live would break/stop the user's Agent, so it was not done.

# Recovery and report-timeline repair — 2026-11-03

## Root causes

- **Cold delegation resume:** `steer_delegation` could resume a persisted child without `agentOptions`. The installed agent loop registers the `model` prompt variable from `context.agent.options.model`; the deployment persona prefix interpolates `{{model}}`; with no live options the assembly failed with “prompt variable `{{model}}` has no value”. The fixed resume reads the durable `modelSelection` projection's `next` selection (pending model/selection or last request), falls back to the route recorded at delegation start, then the last request header, and passes that selection into `ctx.agents.resume` before prompt assembly. It does not use the deployment default as a recovery route. The restored route is written back onto the delegation record.
- **Report timeline:** startup delivery deduplicated committed reports by text and had no durable per-occurrence delivery marker. A reload re-injected old completions, and receipts were displayed at injection time. Reports now carry their actual `endedAt` in their header; delivery is tracked per `(sessionId, endedAt)` (`reportedEndedAt`), legacy state is adopted once through the `reportDeliveryVersion` migration rather than replayed, and committed receipts/registry reports are ordered by completion time. Identical reply text at a later `endedAt` is a distinct occurrence. Immutable session events are not deleted or re-sequenced.

## Observed evidence

- `node --test packages/dsh-sidebar-agent/test/`: **42 passed, 0 failed**, including the real Cordis cold-resume/persona test, the Host delivery/timeline tests, and the browser timeline ordering fixture.
- Cold resume: a disposed child whose last request was `fixture/no-inference` and whose durable pending selection was `fixture/deepseek-flash/high` resumed with agent options `deepseek-flash/high`; the resumed request header recorded `deepseek-flash`; the persona text interpolated `Delegation persona: model deepseek-flash.`; the delegation record followed the restored route.
- Delivery: a completed occurrence injected once; a second `deliverPendingReports` call injected nothing; legacy text was recognized without replay; a new `endedAt` with identical text was delivered; `chatStatus` mapped the committed receipt to `endedAt` 150 and returned only the genuinely uncommitted report at 400.
- Browser timeline: interleaved user/tool/two child reports/assistant turns were displayed in actual-time order across a remount, with both occurrences from one child kept.
- Live read-only audit: the unfinished Sparks worker `session-af1d8d99-4dad-4631-b766-ddb905ba12bd` completed successfully at 13:50:57 (`turn/end` completed; state record now `done`). No recovery mutation was needed. Its last request route at completion was `openai-codex/gpt-6.1-sol`; the earlier `deepseek-official/deepseek-flash/high` observation was from before the recorded model switches.
- Other open-turn candidate: `session-df3684c6-54f1-47df-abde-7746445b20b6` (“Build DSH Ralph Orchestrator Plugin”, `/home/mobrienv/Projects/ralph-orchestrator`) is open at turn 8, last step start 2412, last event 13:19:06, model `openai-codex/gpt-6.1-sol`/`xhigh`. It was left untouched; it is not a Sparks worker and requires owner/parent decision before any restart.
- Nine legacy completed delegation records have no delivery marker; the next Host boot adopts them via `reportDeliveryVersion` instead of injecting their old reports again.

## Deployment status

The Host source changes are complete and tested but **not deployed**. Client-only changes may have reached the existing URL through the client HMR receiver; the sidebar Host plugin must be reloaded for the cold-resume, delivery, and timeline host behavior. A Host reload can interrupt the parent, so it was not performed without explicit parent coordination. No backend restart, forced origin, global default change, downloader, or bulk session mutation was performed.

## Named gaps

- The Host behavior is verified in the Cordis/Node fixtures, not yet in the running Host until the coordinated reload.
- Startup reconciliation for a record whose child completed entirely while the Host was down (record still `PENDING`) is not expanded here; `delegationsOf`/`reconcileOutcome` remain the existing path. The legacy migration deliberately prioritizes not replaying old Done reports.
- Legacy report receipts without the new `at` header can remain at their receipt time when their text no longer matches the current record; new receipts and receipts with the same session/end-time evidence are mapped.
- No bulk recovery of the remaining open Ralph candidate was attempted; its owner should decide.

# Agent settings + right-side Telegram panel — STAGE1 (2026-11-04)

## Scope and mode

Owned files: `packages/dsh-sidebar-agent/**` plus
`.agents/scratch/2026-11-04-sidebar-agent-telegram/`. The Telegram bridge package, profile/package
wiring, live binding state/credentials, and host activation were not touched. The implementation
session header records the actual Creator preset selection (`agent-preset/selected: cordis`) at seq 3,
before the person's prompt at seq 4.

Acceptance checks and substitutions were written first in
`.agents/scratch/2026-11-04-sidebar-agent-telegram/stage1-acceptance.md`; both parent documents
(`acceptance.md`, `preflight.md`) remain authoritative.

## Extension point

No public global right-panel seat exists for the global `main` key: the shell `rightbar` is a SINGLE
root slot occupied by the conversation shell and `rightbar.session` is Session-scoped. The Agent page
therefore gained its own right-side panel inside the existing `section.sa-page`; the shell right bar,
ordinary-session right bars, and retained Session ownership are unchanged. No second chat instance or
multi-Agent framework was added.

## Config / UI contract

- `index.js` exports a real `Config` schema. `title`, `cwd`, `provider`, `model`, and
  `reasoningEffort` are volatile (live-editable); `dataDir` and `telegram` are ordinary configuration
  and never appear as live-edit fields.
- `agent.settings()` returns `{ready, ns, revision, schema, values:{title,cwd,model}, agent, telegram}`
  with the actually effective values: live title, `workingDirectory.get(agent.session)`, and the
  composer-owned `selectionRef`. It never returns `dataDir` or token material.
- `agent.saveSettings({...fields, expectedRevision})` validates (title, absolute existing directory,
  provider/model/effort, revision) and writes through `ctx.settings.mutate(ns, ops, revision)`, then
  renames the live session, changes the working directory, and accepts the model/effort selection.
  Invalid or stale saves write nothing and preserve current values. A title/directory edit never
  restates the model choice.
- The right panel reads effective values, diffs only changed fields, keeps concise labels, and shows
  Telegram `Status`, `Target: Agent`, and `Binding`. At ≥900 px it is a 304 px column; below that it is
  an overlay so 320/390 px chat layout is preserved.
- `telegram-host.js` is the explicit owner seam. `createBridge` (the actual factory) hosts the single
  poller later; its `sessionController` is a facade that routes the Agent's own session id through
  `runtime.agent` steer/followup/cancel and real session events, and forwards every other session id
  untouched. It reuses the bridge's `requestId` correlation, fail-closed `allowedChatIds`, private-DM
  rules, delivery/presence/HTML/dedupe/offset, and approval/question handlers. `/new` in an Agent-bound
  chat is refused before dispatch with an explicit reply.
- Telegram is off by default. `createTelegramHost` does not import the bridge, read a token, poll,
  send, or write state unless `start()` is called explicitly; this stage never calls it.

## Observed evidence

```sh
node --test packages/dsh-sidebar-agent/test/
# 77 tests passed, 0 failed (full suite, including the browser fixture)
node --test packages/dsh-sidebar-agent/test/settings.test.mjs packages/dsh-sidebar-agent/test/telegram-glue.test.mjs
# 32 tests passed (Config/effective/save/invalid/conflict; owner routing/off default//new/real factory)
node --check packages/dsh-sidebar-agent/{index,client,telegram-host}.js
# all syntax checks passed; package.json and locale JSON parse
git diff --check
# no tracked whitespace errors; the package itself is untracked in main
```

- Pre-implementation source failing runs are saved at
  `.agents/scratch/2026-11-04-sidebar-agent-telegram/stage1-pre-implementation-fail.tap` and
  `stage1-pre-ui-fail.tap`; the passing runs are `stage1-host-tests.tap`, `stage1-fixture.tap`, and
  `stage1-full-suite.tap`.
- The real `createBridge` factory was exercised in `telegram-glue.test.mjs` with a temporary
  `dshHome`, `poll:false`, a fake fetch, and the owner facade: `host.prompt` steered the Agent once for
  a redelivered `requestId`, `host.cancel` reached `agent.cancel({kind:'user'})`, and `host.listSessions`
  returned the Agent session plus the ordinary session. No Telegram network call, live state write, or
  poller was used.
- The isolated React fixture (real client module, React 18, fake transport) observed: opening
  Settings shows the effective title/directory/model/thinking and Telegram `Off`/`Target Agent`/`None`;
  a title save sends only `title` plus revision 4 and updates the header; a failed save shows an alert
  and leaves the previous title; the panel fits at 390 and 320 px and the restored chat keeps its
  composer and width. Screenshots: `.playwright-mcp/fixture-settings-1000.png`,
  `fixture-settings-390.png`, `fixture-settings-320.png` (opened and inspected).
- The full current Agent suite remains green: paste, reports/timeline, composer/IME/stop/model/scroll,
  delegated spinner/tags, workspace context, cold resume, and the existing 320 px gate.

## Gaps (named, not claimed as delivered)

- The live GUI was not reloaded/activated. The rendered panel was verified in the isolated browser
  fixture, not in the running profile; the host change requires the coordinated reload below.
- The real platform `settings` service was exercised against its documented contract with fake
  describe/mutate implementations and real `Config` validation, not mounted end-to-end in the live
  profile. The page also intentionally suppresses the generic auto-generated settings page; the panel
  is the supported editor.
- No real Telegram inbound event was observed. Routing is verified with the real bridge factory and a
  fake transport boundary; a synthetic/mocked exchange proves routing fixtures, not a real Telegram
  user's update. A real private topic `/bind <agentSessionId>` is the planned first live check.
- The existing bridge has no DM `/bind`; a private DM can target the Agent only after a seeded/migrated
  DM record or a bridge command change. A private forum topic bound to the Agent session is available
  today.
- `/new` in an Agent-bound chat is refused by the glue's ingress guard (both DM and topic paths); no
  bridge code was changed. A future bridge command could make that reply native.

## Safe activation / migration plan (coordination required)

1. Parent confirms the bridge writer handoff and that the bridge package is quiescent and green, then
   removes the `telegram-session-bridge` bundle row from the live profile (never run two pollers).
   Keep the token env file, state file, and `allowedChatIds` unchanged.
2. Set the sidebar-agent profile row `telegram.enabled: true` with the same `allowedChatIds`
   (`tokenRef` stays an env reference; no token literal in YAML) and reload the sidebar host at an
   idle, coordinated moment.
3. Verify exactly one `getUpdates` poller (no 409), one state-file owner, and that the existing DM/topic
   records still resolve. Bind a private forum topic with `/bind <sidebar-agent session id>`; send one
   authorized private message; observe one prompt, one correlated reply, and no ordinary-session
   ownership fallback.
4. Rollback: set `telegram.enabled: false`, restore the bridge bundle row, reload; the state file and
   credentials were never modified by this stage.

Do not activate this glue while the parent/other Telegram worker is running.

# STAGE2 — review corrections + real merge (2026-11-04)

## Corrections from the independent Stage-1 review

1. **`/new` reply fixed.** The Agent-bound refusal now uses the composed bridge's real `api.sendMessage`
   (not the nonexistent `bot`). The real-factory test seeds an authorized DM through the actual bridge
   store, adopts it to the Agent, sends `/new`, and asserts one visible Bot API send, no ordinary
   `create`, no prompt, no reset, and the Agent binding retained.
2. **Explicit authorized DM adoption.** `agent.telegramAdopt({key})` (also a right-panel **Adopt**
   control) adopts one existing authorized private-DM record to **this live Agent session**. It always
   uses `runtime.sessionId`, rejects unknown/unauthorized/non-DM records, preserves
   `previousSessionId`, and writes only the DM mapping. Offset, dedupe, verbosity, allowlist and every
   other binding are unchanged. Opening the panel or starting the glue never adopts; the ordinary DM
   remains the default until the explicit action. A private forum topic `/bind <agentSessionId>` is
   the other available Agent path.
3. **Stop/start lifecycle.** The glue restores the exact original `handleUpdate` method, clears
   `requestId`/serialization state, bumps a generation guard so a start racing a stop cannot start a
   poller, and creates one fresh bridge on restart. Tested by handler identity and a reused
   `requestId` across restart.
4. **Public factory export.** `dsh-telegram-session-bridge` now exports `./bridge`; a self-reference
   test loads it. The sidebar glue prefers that public subpath and falls back to the documented sibling
   file only when the link-resolved plugin cannot see the bare specifier. No bridge source behavior was
   replaced.
5. **Activation is configuration-gated.** `telegram.enabled: true` starts the merged owner only after
   the Agent is live; unload stops it. The old poller and standalone bundle must be retired in the same
   reload (checkpoint/rollback in `stage2-checkpoint.md`).

## Tests

```sh
node --test packages/dsh-sidebar-agent/test/       # 83 passed
node --test packages/dsh-telegram-session-bridge/test/  # 94 passed
node --check ... ; git diff --check
```

New coverage: real-factory `/new`; real-factory DM adopt + state-file save/reload; offset/dedupe/
allowlist/previousSessionId preservation; unauthorized/unknown/non-DM adoption; caller-supplied
target ignored; cross-chat isolation (adopted DM → Agent, second DM → ordinary controller); owner
history/steer/followup/correlation; stop/start handler restoration and request-id reset; public
factory export; browser-fixture adoption control and default non-adoption.

## Live adoption

Recorded separately after the coordinated handoff; this section is updated only from observed live
evidence, not from tests or a plugin-manager `applied` result alone.

### Panel-only live rollout (2026-11-04 17:10)

The sidebar settings/right panel was adopted with **Telegram disabled**, leaving the standalone
bridge row and bundle untouched as the sole poller. The supported scoped lifecycle
`plugin_manager set_plugin include:sidebar-agent` returned `application: applied`, `warnings: []`;
host PID `608046` did not change and the profile package/patch hashes stayed byte-identical.

Live observations on `https://columba.whydah-theropod.ts.net/` (isolated Playwright context):

- the Agent region and Settings control exist; the right dialog shows the effective title,
  `/home/mobrienv/.dsh/agent/workspace`, `openai-codex/gpt-6.1-sol`, and Telegram
  `Off` / `Target Agent` / `Binding None` / `Private DM None`; no token text; no Adopt control;
- a reversible title save persisted through a page reload, kept the Agent session
  `agent-1f1b4db7-4e1b-4a41-8b43-a967e16f8e3b`, model and message count, and was restored;
- an invalid nonexistent cwd was rejected with an actionable alert and preserved the good values;
- 390 px and 320 px had no horizontal overflow and the composer returned after closing the panel;
- the live profile patch was restored byte-equivalent after the QA save; the old Telegram state
  (offset `171223837`, 20 dedupe entries, one DM still on the ordinary umbrella session) is unchanged.
- Screenshots: `.playwright-mcp/stage2-live-restored-panel-{1280,390,320}.png`,
  `.playwright-mcp/stage2-live-invalid-save.png`, `.playwright-mcp/stage2-agent-after-reload.png`.

The parent Agent was interrupted by the scoped reload (as anticipated) and then woken through its
own `agent` Remote with a labelled automated callback on the same session; no ordinary-session resume
was used. **Full Telegram migration is not active**: no bundle/row change, no adoption, no Telegram
send, and the old bridge remains the only poller.

### Full Telegram handoff and DM adoption (2026-11-04 17:19)

Explicit human authorization moved the existing authorized private DM to the Agent.

- Removed the standalone `dsh-telegram-session-bridge` bundle and explicit profile row in one reload:
  `plugin_manager set_bundle` returned `applied`; host PID `608046` unchanged; the bridge row is gone
  and `sidebar-agent` is active. No second poller/409 was observed.
- The added sidebar row carries `telegram.enabled: true` and the exact `allowedChatIds: [5822509701]`;
  no token literal or `dshHome` override.
- Owner adoption returned `adopted: true` for
  `dm:9229786662:5822509701:5822509701`, targeting
  `agent-1f1b4db7-4e1b-4a41-8b43-a967e16f8e3b`; `previousSessionId` is the old
  `session-24ab9d47-ce94-4314-84d5-bba4809384d6`. Idempotent re-call returned `already: true`.
- Persisted state comparison to the pre-handoff backup: offset, 20 dedupe entries, topic bindings and
  verbosity unchanged; only the DM target and `managedMode: new_replaced` changed. One `agent-*`
  session exists.
- Live panel after reload: Telegram `On` / `Target Agent` / `Binding #5822509701`; title `Agent`,
  model `openai-codex/gpt-6.1-sol`; settings remain valid; panel fits 1280/390/320.
- Parent Agent was interrupted by the scoped reload, then woken through its own `agent` Remote with a
  labelled automation callback; it resumed on the same Agent session and model.

**Named gap:** no real Telegram user inbound has been observed. The persisted DM target, owner API,
previous-session preservation and single-poller ownership are verified; an actual Telegram inbound is
the remaining end-to-end proof and must not be manufactured by replaying updates or sending an
unsolicited message.

### Real authorized DM inbound (2026-11-04 17:20:41)

After adoption, the merged owner's only poller acked `message:5822509701:0:526` and advanced the
offset to `171223838` (21 dedupe entries; no topic bindings or verbosity). The same Agent session
received one `Hi` user message at seq 3059, produced a final reply at seq 3065, and turn 33 completed.
No second Agent/session was created. This is a real inbound through the authorized private chat, not
a fixture or replay. The outbound Telegram send was not independently inspected (no chat-history
probe); user confirmation in the authorized chat is the remaining observation.

### Telegram `/model` for the bound Agent (2026-11-04 19:22)

`/model` is control, not a prompt. In the authorized DM it reports the actual current model and
offers the configured owner catalog as an inline picker; `/model provider/model` is canonical.
The bridge's `ModelPicker` stores a random token and authoritative chat/sender/thread/message/live
Agent binding server-side; callback data is `m:<uuid>:<index>` (≤41 bytes), one-shot, and rejects
forged/stale/unbound/cross-chat/sender/thread/replayed presses. The picker and canonical form call
the same `selectModel` used by the GUI's `setModel`, preserving the current effort only when offered
and otherwise supplying the model's supported default; the shared GUI setter keeps legacy Default
semantics when no effort is supplied. Selection appends the durable `model/selection` event and
updates the live `selectionRef`; `openAgent` restores the durable next selection before a prompt.

Observed: 101 sidebar tests and 94 bridge tests pass; independent review accepted; scoped reload
applied with host PID `608046` unchanged, one poller, same Agent id/model, same DM target and
`previousSessionId`, offset/dedupe unchanged. No real `/model` menu click or live model switch was
performed (named gap); the user can send `/model` in the authorized DM.


### Rich Agent-bound `/status` (2026-11-04 20:24, candidate)

A read-only `statusControl` on the owner surface supplies the current model, context usage, running
delegations and Agent state. Usage is the latest `assistant/message` event's real `usage` metadata
(prompt tokens = input + cacheRead + cacheWrite) divided by the current model's
`ctx.llm.resolveModelInfo().context.contextWindow`; missing usage or window yields `Unknown` with a
reason. Delegations come from the existing `runtime.delegations` registry filtered by live
`ctx.agents.get(sessionId).status === 'running'`, with up to three titles and an exact count. The
bridge formats only for the owner binding; ordinary `/status` is byte-for-byte unchanged. The
provider never prompts/steers/cancels or mutates state, and its failures degrade to binding/verbosity
plus `Agent status unavailable`.

Tests: sidebar 114 passed, bridge 94 passed; `status-control.test.mjs`,
`telegram-status.test.mjs` cover rich render, unknown usage/window, ordinary status, busy read-only,
delegation boundary, provider failure and the real `agentStatus` Remote. Live `/status` remains the
final check; no synthetic Telegram update.


### Deterministic deployment callbacks (2026-11-04 20:48, candidate)

`deployment-callback.js` renders worker fields into the bounded key-value template and the owner
Remote `agent.deploymentCallback` sends that exact text through the existing chat channel (steer when
busy, follow-up when idle) with the final `Automated: deployment callback` marker. Formatting is
code, not model prose: ≤8 lines, one key per line, optional empty keys omitted, long values
flattened/truncated with labels preserved, `LIVE`/`HOLDING`/`BLOCKED` normalized, malformed fields
fail closed to a minimal BLOCKED form, token/API-key patterns redacted, and no raw input echoed.
Tests: formatter snapshots + line cap/omission/truncation/HOLDING/malformed/redaction and the actual
`agentService.deploymentCallback` sender (idle follow-up, busy steer, no cancel/Telegram send).
Sidebar 128 / bridge 94 pass; no bridge source change.


### Delegation stall watchdog + stalled state (2026-11-04 23:10, candidate)

The existing global `session/event` subscription now also feeds a delegation stall watchdog:
`turn/start` arms `{turnActive,lastActivityAt}`, any delegated event postpones/clears, `turn/end`
disarms and preserves the ordinary report. A single 30s sweep marks `stalledAt` after
`delegationStallMs` (default 30m) only when the live delegated Agent is still `running`, injects one
delegation-source status note per episode, and leaves the outcome untouched. `delegationStallAutoCancel`
defaults false; when true it calls `cancel({kind:'user'}, {keepInbox:true})` once per episode.
Records persist `stalledAt/stalledNotified/turnActive/lastActivityAt`; `loadState` sanitizes corrupt or
missing fields to not-stalled. `/status`, `/model`, callbacks, Telegram and ordinary reports are
unchanged. Stalled sessions receive the warning spinner accent, a `Stalled` hover/header pill with
`Stalled delegation` accessible label, a `Stalled` report badge, and `delegations` returns
`state:'stalled'` + `stalledAt`. Tests: `stall-watchdog.test.mjs` (arm/postpone/stall/notify-once/
re-arm, no false stall, restart sanitization/persistence, auto-cancel off/on, tool/remote, actual
session-event handler) and `stall-ui.test.mjs` (parser, pill/mark labels, warning spinner CSS,
narrow layout); sidebar 142 / bridge 94; syntax/diff clean.


### Steer/queue gate v0 + judge plumbing (2026-11-05 07:42, candidate)

Owner ingress (Telegram controller and GUI `chat`) now routes text through
`ingress-gate.js`: pending-question → answer, leading `/steer`/`/queue` override, urgency/correction
regex → steer, otherwise busy → FIFO queue drained at the Agent `turn/end` via followup; idle keeps
the ordinary followup. `gate.mode: off` restores always-steer. Every decision is one append-only
record in `dataDir/decision-log.ndjson` with batched fsync, 5MB rotation, and no message body.
`gate.judge` is an OpenAI-compatible loopback-only typed client that falls back to rules on
timeout/malformed/low-confidence/non-local/disabled; it ships disabled. Part C stopped: the source's
`prithivMLmods/clef-flash-GGUF` is 401; the public `ggml-org/Clef-Flash-GGUF` Q4_K_M is 6.73GB not
5.63GB, is a `/v1/systemone` decision model requiring unmerged llama.cpp PR 29831, not chat
completions. No service/download/build. Tests: gate rules/precedence/queue/log/rotation/owner path,
judge fake-server success/timeout/malformed/low-confidence/disabled/non-local, GUI chat gate and
callback bypass. Sidebar 177 / bridge 98; syntax/diff clean.
