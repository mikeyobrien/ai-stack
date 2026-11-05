# Sidebar Agent

An always-on agent in the left sidebar. The Agent icon opens one long-lived chat: the same session,
with the same history, for as long as the Host runs. There is no Agent workspace and no session row
in the workspace list — the Agent page is the only door.

The Host creates the agent when the plugin loads and resumes the same session on later boots. The
session is created with subagent origin, which is how the sidebar hides it, while the plugin keeps it
live and reads its surface directly. The agent runs the deployment's default Agent preset with the
standard tools, and the page renders the session's own surface.

## Delegations

| Tool | What it does |
|---|---|
| `delegate` | Starts a session in a workspace with the brief, returns its session id and title |
| `delegations` | Lists the agent's delegations with state and last line |
| `steer_delegation` | Steers a running delegation, or resumes a finished one with a follow-up |
| `stop_delegation` | Stops a running delegation; its session and work stay |

A delegation is an ordinary session in a workspace: it is created with the workspace directory as its
`cwd` and attached to that workspace, so it appears in the sidebar under it. It is not a subagent
child, and the agent must not delegate through the subagent tools. When a delegation's turn ends, the
agent receives one report in its own chat, rendered as a delegation report rather than as the
person's words. A stop the agent asked for itself is answered once by the tool and sends no second
report.

The delegation registry is durable in `state.json`, so the agent's tools and reports survive a
restart. A delegation that was running when the Host stopped reads `Interrupted` and can be continued
with `steer_delegation`.

Delegated sessions are tagged from that registry: a small share glyph in the idle Session row's
leading cell, and a `Delegated` pill in the row's hover card and in the conversation header next to
the title. The Client reads the ids and stalled ids from the `delegated` Remote and refreshes them
every two seconds. While a delegated session is running, its status spinner uses the theme's link
accent; a stalled one uses the warning accent, its hover/header pill says `Stalled` with the
`Stalled delegation` accessible label, and its report note carries the `Stalled` badge. The row keeps
the owner's status dot/label; there is no row-text status slot, so the state word lives in the
hover/header pills and the accessible mark. Unrelated session spinners are unchanged.

### Stall watchdog

The same global `session/event` subscription used for reports is the event seam: `turn/start` arms
one delegated record, every delegated-session event postpones it, and `turn/end` disarms it. A single
30-second sweep checks armed records whose live Agent is still `running`; after
`delegationStallMs` without activity (default 30 minutes) it sets `stalledAt`, injects one
machine-worded delegation status note, and leaves the outcome untouched. Any new activity clears the
stall and re-arms; a later quiet period is a new one-note episode. `delegationStallAutoCancel` is off
by default; when true it calls the delegated Agent's `cancel({kind:'user'}, {keepInbox:true})` once
per episode. `stalledAt`, `stalledNotified`, `turnActive`, and activity timestamps persist in
`state.json`; corrupt/missing fields sanitize to not-stalled and a non-live record is never marked.

## Workspace awareness

Before each turn, the Agent's existing runtime-context snapshot includes the current registered
workspaces as compact JSON: stable `id`, display `title`, and absolute `path`. It reads the same
Workspace registry as the sidebar, including additions, renames, and removals. The registry has no
host/remote identity fields. Ungrouped is not a workspace record.

This contribution belongs only to the always-on Agent's scope, not ordinary sessions or delegations.
Names and paths are literal data, not instructions or authorization to act. No session histories,
project files, or other workspaces' instructions are included. The existing snapshot projection skips
unchanged copies; changed snapshots supersede earlier snapshots without deleting historical events.

## Ingress gate

Text arriving while the Agent is mid-turn passes through the owner ingress gate (Telegram owner
controller and the GUI `chat` Remote). Pending-question replies are answer-context, leading
`/steer`/`/queue` override, an urgency/correction regex steers, and everything else **queues** FIFO.
The queue drains at the Agent's `turn/end` through the existing follow-up path, so it waits at most
one turn; idle messages keep the ordinary follow-up. `gate.mode: off` is the legacy always-steer
kill switch. Files bypass the text gate. Every decision appends one bounded record to
`dataDir/decision-log.ndjson` (batched fsync, rotate 5MB, no message body or secrets):

```json
{"ts":"…","session":"…","features":{"pendingQuestion":false,"urgent":false,"explicit":null,"queuedCount":0,"msgLen":42},"choice":"queue","path":"default-queue","latencyMs":1}
```

### Pulse feed

`pulse { sessions }` is profile-config-only in v1 (not exposed in the settings UI). For each watched
session `turn/end`, the sidebar Agent receives one bounded digest with the literal `pulse` header,
session/title, end reason, duration, last human prompt (≤200 chars) and final assistant text (≤400
chars), redacted and capped by `pulse.maxDigestChars`. Digests coalesce within
`pulse.minQuietSeconds` (default 60) and are delivered through the same owner chat channel as
deployment callbacks (steer while busy, follow-up while idle). The Agent's own session is ignored
even if listed. Cross-restart dedupe is the persisted `pulseLastSeen` seq map in `state.json`;
legacy `sponsorLastSeen` is read once. The accepted `sponsors`, `sponsorMinQuietSeconds` and
`sponsorMaxDigestChars` keys remain back-compat aliases. Empty `pulse.sessions` disables the feed.

`gate.mode: judge` uses `gate.judge` only when enabled. The client is loopback-only and supports
OpenAI-compatible `/chat/completions` plus the actual Clef `/v1/systemone` typed-choice endpoint;
both return the same `{choice,confidence,reason}` shape and fall back to rules on timeout/malformed/
low-confidence/non-local/disabled. It ships disabled; the local Clef service is documented separately.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `title` | `Agent` | Agent name, used in the prompt and on the page |
| `cwd` | `<dataDir>/workspace` | The agent's own directory (not a workspace) |
| `dataDir` | `<DSH_HOME>/sidebar-agent` | Durable state and the agent's directory |
| `provider` / `model` | deployment default | Route for the agent's own turns |
| `reasoningEffort` | provider default | Effort for the agent's own turns |
| `delegationStallMs` | `1800000` | No-activity threshold for an armed delegation turn |
| `delegationStallAutoCancel` | `false` | Opt-in keep-inbox cancel on stall; mark+notify only when false |
| `pulse.sessions` | `[]` | Watched session ids whose turn completions feed this Agent; empty = off |
| `pulse.minQuietSeconds` | `60` | Minimum spacing between Pulse digests; multiples coalesce |
| `pulse.maxDigestChars` | `1200` | Hard cap on one Pulse digest |
| `sponsors` / `sponsorMinQuietSeconds` / `sponsorMaxDigestChars` | — | Accepted back-compat aliases for the Pulse keys |
| `gate.mode` | `rules` | `off` legacy always-steer, `rules`, or `judge` |
| `gate.judge` | off | `{ enabled:false, url, model, timeoutMs:2500 }`; loopback OpenAI-compatible fallback |
| `telegram` | off | `{ enabled, tokenRef, allowedChatIds, dshHome, poll, ... }`; dormant in this stage |

`title`, `cwd`, `provider`, `model`, and `reasoningEffort` are the live-editable fields of the
plugin's exported `Config` schema. `dataDir` and `telegram` are ordinary configuration: they are
validated and preserved, but they are not live-edit fields on the Agent page (changing `dataDir`
would create a fresh Agent, and enabling Telegram starts a poller).

Delegations use the agent's route unless `delegate` names `provider` and `model`. A delegation
that `steer_delegation` resumes after a restart keeps the route of its last request.

## Settings

The Agent page's right-side panel is the supported settings surface. It reads the platform
settings descriptor and revision, overlays the values actually in effect (the live title, the
Agent session's working directory, and the composer-owned model/effort selection), and saves
through `ctx.settings.mutate(ns, ops, expectedRevision)`. A save renames the live session, moves
its working directory, or accepts the model/effort selection without replacing the Agent or
losing its id/history. Invalid values are rejected before any write; a stale revision is refused;
`dataDir`, the Telegram block, and token references are not editable from this panel and no token
value is returned. Saving only the title or directory leaves the current model choice untouched.

The generic auto-generated settings page is suppressed for this row because it would show the
row's config defaults after a composer model change; the exported schema remains discoverable
through the platform Config inspector.

## Automated deployment callbacks

`agent.deploymentCallback({fields})` renders a fixed key-value callback and sends it into this same
Agent through the existing owner chat channel (steer while busy, follow-up while idle). The worker
supplies `{what, state, changed, verified, stateLine, live|holding, gaps}`; the formatter owns the
shape: top line `<what>: <STATE>`, then optional `Changed:`, `Verified:`, `State:`, `Live:`/`Holding:`,
`Gaps:`, and the final `Automated: deployment callback` marker. Output is at most eight lines, one
line per key, values flattened/truncated, empty keys omitted, malformed required fields reduced to a
minimal BLOCKED form, and token/API-key-shaped text redacted. This is a callback, not a Telegram
send; it never changes model/binding/offset.

## Telegram

`telegram-host.js` is the explicit owner seam for the existing Telegram bridge. It is inert by
default (`enabled: false`): no bridge import, token read, poller, send, or state write occurs. When
activated by a later coordinated handoff it:

- lets the existing `createBridge` factory host the single poller (no second bot, poller, or
  store), reusing its HTML rendering, presence, dedupe/offset, delivery, and approval/question
  handlers. The factory is imported through the documented sibling relative seam until the bridge
  package releases a public factory subpath; no bridge file is edited;
- passes an owner `sessionController` facade: the Agent's own session id is driven through
  `runtime.agent` steer/followup/cancel and its real session events (the ordinary session controller
  fences this `origin: subagent` session), while every non-migrated session id is forwarded untouched
  to the host Session Controller;
- correlates prompts by the bridge's `requestId` (a redelivered update is applied once), serializes
  owner prompt application, and reuses the bridge's fail-closed `allowedChatIds` and private-DM
  checks;
- refuses `/new` in an Agent-bound chat before dispatch, with an explicit reply, so it can never
  fork or reset the global Agent or turn it into an ordinary session;
- offers an explicit right-panel adoption for one already-authorized private DM. The panel lists
  the current bot's DM candidates; nothing is written until **Adopt** is pressed. Adoption always
  targets this live Agent session, records the former ordinary session as `previousSessionId`, and
  leaves the offset, dedupe table, verbosity, allowlist and every other binding untouched.
  The bridge has no DM `/bind`; a private forum topic `/bind <agentSessionId>` remains the other
  Agent path.

In a chat bound to this Agent, `/status` reports the current model, real context usage (latest
`assistant/message` usage divided by the resolved model context window, or `Unknown`), the live
running-delegation count with up to three titles, Agent busy/idle, binding and verbosity. It is
read-only and never prompts, steers, cancels or mutates state. Ordinary-session `/status` is
unchanged.

`/model` is intercepted as control in the bound Agent DM/topic. It reports the actual current model
and shows the configured catalog as an inline picker; `/model provider/model` is the canonical
shortcut. Selection uses the same owner setter as the GUI (`setModel`), preserves the current
reasoning effort only when the chosen model offers it (otherwise the model default), appends the
durable `model/selection` event, and never prompts or cancels a turn. Callback data carries only a
random token and index; the authoritative chat/sender/thread/message and live Agent binding are
checked again on click, and a selection applies once.

Activation is the explicit `telegram.enabled` config value after the old poller is retired: the
glue starts once the Agent is live, and stops/restores the bridge handler on unload. Enabling it
while the standalone bridge is still running would create two pollers and is not supported.

`telegram` status reports state, whether it is enabled, the Agent's binding coordinates, and the
authorized DM candidates only. No token material is returned.

The `agent` Remote exposes `settings`, `saveSettings`, and `telegramAdopt` only; the page never
receives a token. `telegramAdopt` can only name an existing DM record and always binds this live
Agent session, never a caller-supplied session id.

## Where it attaches

| Hook | Owner | Use |
|---|---|---|
| `sidebar.panellist` id `agent` | `ui-sidebar` | The Agent icon in the left sidebar |
| `main` key `agent` | `ui-layout` | The chat page |
| `conversation.session.header.actions` id `delegated-tag` | `conversation` | The `Delegated` pill beside a delegated session's title |
| `sidebar.session.row.hover` id `delegated-hover` | `ui-workspace` | The pill in a delegated row's hover card |
| `sidebar.session.row.leading` id `delegated-mark` | `ui-workspace` | The icon in a delegated row's idle leading cell |
| Remote namespace `agent` | this plugin | `status`, `delegated`, `catalog`, `chat`, `setModel`, `settings`, `saveSettings`, `telegramAdopt`, `image`, `stop` |

The page polls `status()` every 1.5 seconds while it is open and refreshes on tab visibility. The chat
renders the session's current surface — the person's messages, the agent's answers, tool calls with
their results, and delegation reports — and sends through `chat`, which steers while the agent works
and queues a follow-up when it is idle. The chat has no approval or question surface, so the agent's
scoped tools deny `ask_user_question` and `exit_plan_mode`; its answers and tool calls are the whole
interaction.

Assistant answers go through the platform's safe Markdown primitive, so headings, lists, tables,
links, and code blocks keep their structure. The conversation uses a centered 660 px column in a wide
panel; code and tables scroll inside their own block. The panel sets the platform Markdown scale to
its own content size — 14 px/24 px body at desktop and 16 px/26 px at narrow widths, with 13–14 px
tables and 12–13 px code — so assistant prose matches user bubbles instead of inheriting the shell's
10 px content preference. A person's turn stays a compact right-aligned bubble, while an assistant
turn is unbubbled. Consecutive execution calls collapse into one disclosure with a human phrase, a
count, and a failure count; expanding it reveals each row and its result, never the raw arguments. An
image the agent read with `read_image` is shown under its row, and an image the person attached is
shown as a thumbnail in the message, both fetched through the `image` Remote from the stored bytes.

A delegation report is a distinct collapsed section: its title, workspace, session id on expansion,
and outcome in a small badge. Expanding it renders the report body with the same Markdown primitive.
A report is not rendered as the person's message. The expanded report body and an expanded activity
body are capped at `min(50dvh, 28rem)` and scroll internally with contained overscroll; the title,
badge, and collapse control stay outside that scroller. A tool result detail keeps its 200 px cap.
The main transcript is never capped. A disclosure toggle does not pin the transcript, so a long
report cannot pull the conversation away from where the person is reading.

A cold delegation resume restores the session's persisted NEXT model selection — a pending
`model/selection`, else the last request header, else the route recorded at delegation start — and
passes it into the resumed agent before prompt assembly. The persona's `{{model}}` therefore resolves,
and the delegation's route is not silently replaced by the deployment default. The restored route is
written back onto the delegation record for later resumes.

A completion report carries its actual end time in its header, and delivery is tracked per
`(sessionId, endedAt)` occurrence. A Host reload does not inject an already-delivered Done again;
legacy state without the delivery marker is adopted once instead of replaying old reports. Because
the occurrence identity is the end time rather than the report text, a genuine follow-up completion
with identical reply text is a distinct report. The chat orders committed receipts and registry
reports by actual completion time, not by when the Host happened to inject them.

The composer owns the model and thinking selectors next to the input: labeled controls that truncate
rather than wrap, a menu bounded to the panel width, and Stop in the same control row while a turn
runs. Send stays available while running because the Host treats that send as a steer. The textarea
auto-sizes to a cap, Enter sends, Shift+Enter inserts a newline, and an IME composition or keyCode 229
never submits. Escape stops a running turn. The attach button accepts up to eight files of 10 MB
each; images become durable image attachments and other files durable file attachments, and the agent
sees them in the message.

Pasting an image from the clipboard uses the same attachment path as the file picker: the paste
event's files (or file items when a browser exposes only those) are validated, read, previewed as a
removable chip, and sent as an image. No clipboard read permission is requested, image-only sends are
allowed, and an identical pasted image is not attached twice. A text or multiline paste is left to
the browser; an unsupported or oversized image shows the attachment error and keeps the draft.

The transcript is a `role="log"` region. It only follows the bottom while the reader is already
there; scrolling into earlier turns freezes the position, shows a `Latest` control, and native scroll
anchoring keeps expanded rows from moving the sentence being read. Reduced motion turns the return
into an instant jump. A visually hidden `role="status"` announces running, stopped, and reply-complete
changes without announcing every streamed token.

The Agent composer is not the shared Conversation composer: it sends through the `agent` Remote and
does not own a browser-retained session. Slash commands therefore remain unavailable in this panel.
Reusing the command registry here would bind commands to an ordinary session scope that the panel
does not own, so no parallel parser is added.

## Layout

| File | Purpose |
|---|---|
| `index.js` | Host: agent lifecycle, delegation tools, reports, chat/settings Remotes |
| `client.js` | Browser: sidebar icon, chat page, right-side settings/Telegram panel |
| `telegram-host.js` | Owner adapter + Telegram glue (bridge reuse; model/status-control seam) |
| `deployment-callback.js` | Deterministic bounded automated deployment-callback formatter |
| `cordis.patch.yml` | Inserts the plugin row |
| `locale/en.json` | Bundle and UI display text |
| `icon.svg` | Artwork for the plugin manager |
| `test/host.test.mjs` | Host helpers plus delivery/timeline/report-occurrence tests |
| `test/client.test.mjs` | Client module, grouping, report, spinner, and composer keyboard tests |
| `test/workspace-context.test.mjs` | Isolated registry-to-Agent turn-context and real Cordis cold-resume/persona tests |
| `test/settings.test.mjs` | Config schema, effective reads, save/apply, invalid and conflict paths |
| `test/telegram-glue.test.mjs` | Owner routing, `/new` refusal, off default, real bridge factory boundary |
| `test/fixture.test.mjs` | Isolated browser fixture: states, IME, clipboard image paste, draft retention, scroll, caps, menu, 320 px reflow |
| `test/fixture/` | Fixture page, fake transport, and static server (no host, no live Agent) |
| `VERIFICATION.md` | Acceptance checks, observed evidence, and deployment boundary |

The browser fixture needs React UMD outside the plugin workspace (it is not a production dependency):

```sh
mkdir -p /tmp/sa-fixture
(cd /tmp/sa-fixture && npm install react@18.2.0 react-dom@18.2.0)
node --test test/
```

`SA_REACT_DIR`, `DSH_WEB_PROFILE`, and `SA_CHROMIUM` override the detected React, Playwright profile,
and Chromium paths. The fixture test skips when React UMD is absent.
