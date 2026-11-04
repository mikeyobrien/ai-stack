# dsh-telegram-session-bridge — build notes

Thread-per-session Telegram bridge. Zero-runtime-dep cordis host plugin for
`@deepseek-ai/dsh` 0.2.1-rc.5. Spec: `~/.dsh/im/.agents/scratch/2026-11-04-telegram-session-bridge/`
(one-pager = scope; prior-art.md = schema/failure modes; first-principles.md M1–M8 = acceptance).

## SPIKE (day one) — verdict: GO, parity achievable in-host, no core changes

Verified 2026-11-04 against the installed host at `~/.local/share/dsh/node_modules/@deepseek-ai/`
(0.2.1-rc.5, read-only) and the running instance (`127.0.0.1:3080`, dsh-im 5.10.0 composed in
`~/.dsh/profile/web`).

### (a) Push envelopes are observable by a host plugin — CONFIRMED

dsh-im's in-host code (`plugin-src/host/modern-harness-api.mjs`) subscribes with plain cordis
events from inside the host process:

- `ctx.on('session/event', (session, event) => …, { global: true })` — every durable session
  event, `event.seq` usable as cursor (lines ~279–283).
- `ctx.on('agent/assistant-stream', ({ agent, frame }) => …, { global: true })` — live token
  frames (line ~287).
- `ctx.on('approval/request', (request, next) => …, { global: true, prepend: true })` — the
  approval waterfall; claim by inspecting `request.agent.session` events
  (`approval/asked` / `approval/decided`), then settle or `next()` (line ~293).
- `ctx.on('user-questions/request', (request, next) => …, { … })` — same shape for ask-user
  (line ~298).

The broadcast envelope payload types are exactly `approval/requested`, `question/requested`,
`session/event`, `approval/resolved` (`#approvalFrame` line ~724, `#questionFrame` line ~546).
dsh-im runs this daily on this host build — operational, not just source-level, proof.

### (b) `session.prompt{mode, content[]}` round-trips — CONFIRMED

`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js`:

- `@Remote('prompt') async prompt(request: SessionPromptRequest, signal): Promise<SessionPromptValue>`
  (line ~2130).
- `SessionPromptRequest { requestId, sessionId, mode: 'queue' | 'steer',
  content: readonly PromptContentPart[], clientTimeZone? }` (line ~2911).
- `PromptContentPart = { type:'text', text } | { type:'image', mediaType, data, name? } |
  { type:'file', receiptId }` (line ~2647) — text is all the MVP needs; images later.

`session.cancel` (keepInbox — verify flag name during implementation), `history`, `rename`,
`selectModel`, `permissions` are sibling `@Remote`s on the same service.

### Host-plugin shape (CaptainPersia / dsh-im confirmed)

- Package: `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; patch row
  `- insert: [{ id: <kebab>, name: <pkg> }]` (templates: `~/.dsh/im/pr-review-plugin/`,
  dsh-im's own `cordis.patch.yml`).
- Entry: `export const name`; `export const inject = […]`; `export async function apply(ctx, config)`.
  Late services via `ctx.inject(['sessionController', 'webServer'], cb)` (dsh-im host index.mjs:164–172).
- Injectables seen in the wild: `sessionController, sessionQuery, workspaceChanges,
  typertGateway, credentials, webApp, connection, systemPrompt, tools`.
- Claim semantics (dsh-im `#respond`, line ~899): pending map keyed by rpcId; one-shot — first
  `respond` wins; validation `{ sessionId, approvalId, outcome: 'allowed-once' | 'rejected' }`;
  rejects `not-pending` / `bad-response`. Our bridge mirrors this with its own pending map per
  bound session.

### Coexistence rule (deduced, to honor in implementation)

dsh-im claims an approval only when it can (`hasActiveHarnessInteractionOwner` guard, prepend
waterfall). The bridge must claim **only sessions bound to it** and settle via its own pending
map; unbound sessions fall through `next()`. Never touch dsh-im's bot token — second bot
identity via tokenRef env credential (two long-polls on one token 409).

### Runtime probe caveat

Injecting a probe plugin requires a host reload — out of scope while "do not restart the live
DSH server" stands. Source + running-instance evidence above is the spike deliverable; the
first real end-to-end proof arrives with the plugin's own fake-host tests, then a supervised
load.

## Implementation

Status: MVP implemented on branch `ai-stack-dsh-telegram-session-bridge-impl`,
zero runtime dependencies, `node --test test/` = 50 tests green in under a
second. Design bets from the spike (push envelopes, `session.prompt`, cancel with
`keepInbox`) are the code's seams; nothing in `~/.local/share/dsh` changed.

| Module | Responsibility | Invariant it owns |
| --- | --- | --- |
| `src/index.js` | Cordis entry: `name`, `inject`, `apply(ctx, config)` | Subscribes `session/event`, `approval/request`, `user-questions/request`; an unusable config logs `disabled:` and returns without blocking boot. |
| `src/bridge.js` | Composition root and lifecycle | One object the tests drive without cordis; `start()` reads `getMe` capabilities then starts the poller; `stop()` aborts the poller and stops the watchdog. |
| `src/config.js` | Resolve the profile row once at boot | Token only from the env var named by `tokenRef` (dsh-im names rejected); state under `$DSH_HOME/telegram-session-bridge/`; `allowedChatIds` fail-closed; bounded watchdog/poll/chunk/dedupe knobs. |
| `src/state.js` | Durable side-table, versioned JSON v1 | Atomic tmp+fsync+rename; UNIQUE(session) with idempotent same-pair rebind; `managedMode` provenance (`auto`, `restored`, `new_replaced`); restore-with-replay; offset + inbound dedupe acked in the same write; unknown version refused, corruption quarantined. |
| `src/delivery.js` | Deterministic delivery from the binding | Outbound address comes from the session's binding, never the model or the last chat; verbosity gates tool/thinking digests; a Telegram-originated prompt is not echoed twice; arms/touches/disarms the watchdog. |
| `src/interactions.js` | In-host approval/question owner | Claims only bound sessions, one-shot pending map, first `respond`/button wins, later presses stale; unbound requests `next()`; abort resolves cancelled (`ASK_ABORTED` for questions). |
| `src/watchdog.js` | Stuck-turn recovery | One timer per bound session; no activity for `stallTimeoutMs` → topic notice → host `cancel{keepInbox:true}`; later prompts re-arm; `turn/end` disarms. |
| `src/commands.js` | Operator surface and prompt ingestion | `/bind`, `/new`, `/unbind`, `/verbosity`, `/sessions`, `/status`, `/help`; `/bind`/`/new` refuse the DM lobby (thread 0); plain text prompts the bound session. |
| `src/poller.js` | `getUpdates` long-poll | Ack (dedupe key + offset) is durable before dispatch; dedupe keyed `(chat, thread, message/callback id)` so a restart cannot replay; 409/network failures back off instead of crashing the host. |
| `src/telegram.js` | Minimal Bot API client over `fetch` | JSON calls with 429 `retry_after` handling; `sendMessage` chunks at the limit; `message_thread_id` omitted for topic 0/General(1), carried for numbered topics. |
| `src/chunk.js` | 4096-char splitter | Joining chunks reproduces the input; code-point-safe (no split surrogate pair); prefers newline boundaries. |
| `src/host.js` | Adapter over the host session service | `prompt`/`cancel`/`list`/`page` through the same Remote the GUI uses; extracts visible assistant finals (skips preambles with tool calls, interrupted/non-append events) and replays the last one. |
| `src/util.js` | Shared helpers | `sleep` (abortable), `formatDuration`, `oneLine` digest trimming. |

`cordis.patch.yml` inserts the single row `telegram-session-bridge`; operator
steps (second bot, topics, token env, row config, commands, rollback) are in
[INSTALL.md](INSTALL.md).

## Coexistence rules (honored in code)

- **Separate identity.** The bridge reads only the token in the env var its
  `tokenRef` names and rejects dsh-im-looking names. Two long-polls on one token
  would fight; it never touches dsh-im's bot.
- **Claim only your sessions.** `approval/request` and `user-questions/request`
  are prepend handlers that claim a request only when the requesting session has
  a binding here; everything else falls through `next()` to dsh-im/the GUI.
- **One-shot settlement.** The bridge keeps its own pending map per bound
  session; it does not mutate dsh-im state or DSH core.
- **Separate state.** `$DSH_HOME/telegram-session-bridge/state.json` is the only
  file written; no DSH or dsh-im store is opened for writing.
- **No core changes, no host restart in tests.** The plugin is a normal bundle
  row and can be removed like one.

## Test matrix — every M1–M8 item has a named test

`test/coverage.test.js` fails if a milestone loses its `[M#]` tag or one of the
required phrases. Run all: `node --test test/`.

| Requirement | Named tests |
| --- | --- |
| M1 — binding store: UNIQUE(session), idempotent rebind, provenance, restore-with-replay, versioned atomic JSON | `[M1] bindings persist as versioned JSON through an atomic tmp+rename`, `[M1] the same topic and session rebind idempotently`, `[M1] one session cannot be linked to two topics (UNIQUE(session))`, `[M1] managed_mode provenance is recorded for auto, restored and new_replaced`, `[M1] restore replays the last assistant message from the host`, `[M1] state and verbosity survive a reload`, `[M1] topic id 0 (the DM lobby) cannot be bound`, `[M1] /new creates and binds a session, replacing the old binding` |
| M2 — deterministic delivery from the binding, never model-mediated | `[M2] an assistant final is delivered to the bound topic`, `[M2] delivery follows the binding, not the last chat used`, `[M2] an unbound session produces no output at all` |
| M3 — host wiring: push envelopes, one-shot interaction waterfall, lifecycle | `[M3] apply subscribes to the host push envelopes and drives the real Bot API end to end`, `[M3] an unbound approval falls through next() to the native GUI answerer`, `[M3] disposing the host effect stops the watchdog and its timers`, `[M3] an approval request with no matching approval/asked event falls through` |
| M4 — safe failure modes: missing token, no eager state, corrupt/future state, unbound lobby | `[M4] a missing token disables the plugin without blocking host boot`, `[M4] loading creates no state and writes nothing until the operator binds`, `[M4] a corrupt state file is quarantined instead of silently overwritten`, `[M4] a future state version is rejected instead of rewritten`, `[M4] unbound lobby text is answered with instructions instead of entering a session` |
| M5 — approvals and questions claimed, answered once, otherwise fall through | `[M5] a bound approval is claimed from the push envelope and answered once`, `[M5] a bound approval is answered from a Telegram callback through the poller`, `[M5] rejecting is a one-shot rejection outcome`, `[M5] an aborted approval resolves cancelled and stops accepting presses`, `[M5] a bound question returns the selected labels to the host`, `[M5] a multi-select question toggles options and finishes on Done`, `[M5] an aborted question rejects with the host ASK_ABORTED code`, `[M5] an unbound approval falls through next() to the GUI`, `[M5] an unbound question falls through next()` |
| M6 — transcript parity, no duplicate echo of own prompts | `[M6] web-originated user turns and assistant finals keep transcript parity`, `[M6] a prompt sent from Telegram is not echoed back as a duplicate`, `[M6] a different web turn is still echoed after one own prompt is consumed` |
| M7 — `/verbosity` per chat/topic, persisted, default quiet, higher levels add digests | `[M7] verbosity defaults to quiet per topic and persists across a reload`, `[M7] quiet delivers finals only; normal adds tool digests; verbose adds thinking digests`, `[M7] a higher level still delivers the final answer`, `[M7] /verbosity persists per topic across a bridge restart` |
| M8 — stall timeout → notice → `cancel{keepInbox}`, recovery re-arms | `[M8] a stalled turn is notified and cancelled with the inbox kept`, `[M8] activity postpones the stall and a new prompt re-arms after recovery`, `[M8] unbound sessions are never watched`, `[M8] turn/end disarms the watchdog through the delivery path` |
| Transport (supports M1/M6) — chunking, dedupe across restart, topic params, token isolation | `[transport] long assistant text is chunked at the Telegram limit without loss`, `[transport] chunking never splits a surrogate pair`, `[transport] duplicate updates are suppressed across a simulated restart`, `[transport] dedupe keys include both chat and thread`, `[transport] the General topic omits message_thread_id on send, numbered topics keep it`, `[transport] sendMessage and getUpdates carry the real Bot API parameters`, `[transport] tokenRef is an env credential and never dsh-im's bot identity` |
| Package invariants | `[package] the bridge keeps zero runtime dependencies`, `[M1–M8] every acceptance requirement has a named test` |

## Test harness

`test/` is `node --test` with a fake host and a fake Bot API bound to
`127.0.0.1`. Both are test doubles of the confirmed host contracts, not mocks of
our own modules.

**Cordis effect contract.** The fake host's `effect(fn)` runs `fn` immediately
and stores the disposable `fn` returns (or resolves to), then `dispose()` awaits
each one in reverse. This mirrors cordis `Fiber._execute`: a returned function is
collected as the disposer, and an async function that resolves to one is
collected too. An earlier fake stored the callback itself and called it on
dispose, so `src/index.js`'s `effect(() => async () => …)` disposer was dropped,
`bridge.stop()` never ran, and a test left a 60 s watchdog timer holding the
process open — a one-minute suite that looked merely "slow". The `[M3] disposing
the host effect…` test pins the contract so a dropped disposer fails fast instead
of hanging the suite.

No real credentials, no network, and no live DSH instance are needed for the
tests.
