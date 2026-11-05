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
zero runtime dependencies, `node --test test/` = 93 tests green in under a
second. Design bets from the spike (push envelopes, `session.prompt`, cancel with
`keepInbox`) are the code's seams; nothing in `~/.local/share/dsh` changed.

| Module | Responsibility | Invariant it owns |
| --- | --- | --- |
| `src/index.js` | Cordis entry: `name`, `inject`, `apply(ctx, config)` | Subscribes `session/event`, `approval/request`, `user-questions/request`; an unusable config logs `disabled:` and returns without blocking boot. |
| `src/bridge.js` | Composition root and lifecycle | One object the tests drive without cordis; `start()` reads `getMe` capabilities then starts the poller; `stop()` aborts the poller, the host adapter's lifetime signal, the watchdog and typing presence. |
| `src/config.js` | Resolve the profile row once at boot | Token only from the env var named by `tokenRef` (dsh-im names rejected); state under `$DSH_HOME/telegram-session-bridge/`; `allowedChatIds` fail-closed; bounded watchdog/poll/chunk/dedupe knobs. |
| `src/state.js` | Durable side-table, versioned JSON v1 | Atomic tmp+fsync+rename; UNIQUE(session) with idempotent same-pair rebind; `managedMode` provenance (`auto`, `restored`, `new_replaced`); restore-with-replay; offset + inbound dedupe acked in the same write; unknown version refused, corruption quarantined. |
| `src/delivery.js` | Deterministic delivery from the binding | Outbound address comes from the session's binding, never the model or the last chat; only assistant finals go through the HTML renderer, while echoes, digests, errors and every command reply stay plain text; echoes only `user/message` with `source.kind === 'user'`; verbosity gates tool digests and reasoning-block digests (`assistant/message.content[type=reasoning]`); failed turns are read from `turn/end.reason.kind === 'error'`; arms the watchdog on `turn/start`, touches on activity, disarms on `turn/end`. |
| `src/interactions.js` | In-host approval/question owner | Claims only bound sessions, one-shot pending map, first `respond`/button wins, later presses stale; unbound requests `next()`; abort resolves cancelled (`ASK_ABORTED` for questions); question options wrap three per keyboard row so none are hidden. |
| `src/watchdog.js` | Stuck-turn recovery | One timer per bound session; no activity for `stallTimeoutMs` → topic notice → host `cancel{keepInbox:true}`; later turns re-arm; `turn/end` disarms. |
| `src/presence.js` | Typing loop and prompt reactions | One typing loop per bound chat/topic: `turn/start` sends `sendChatAction` immediately then every 4 s (Telegram clears it after ~5 s); `turn/end` (any reason), unbind, `/new` and bridge stop clear it. The prompt message gets 👀 for the last prompt only, swapped to ✅ on `{kind:'completed'}` and ⚠️ on `{kind:'error'}`; other endings leave it. All Bot API failures are swallowed and logged at most once — presence can never break prompt ingestion or delivery. Timers are injected like the watchdog's (`{setTimeout, clearTimeout}`). |
| `src/commands.js` | Operator surface and prompt ingestion; Agent-bound `/status` consumes an injected read-only status control and keeps the ordinary status text unchanged. | `/bind`, `/new`, `/unbind`, `/verbosity`, `/sessions`, `/status`, `/model`, `/help`; `/bind`/`/new` refuse the DM lobby (thread 0); plain text prompts the bound session (topic and DM paths) and puts 👀 on that user message after the prompt is accepted; commands and unbound topics get no reaction. It never arms the watchdog itself — the host's `turn/start` is the only arm point, so a prompt that throws cannot leave a timer that later cancels unrelated work. |
| `src/poller.js` | `getUpdates` long-poll | Ack (dedupe key + offset) is durable before dispatch; dedupe keyed `(chat, thread, message/callback id)` so a restart cannot replay; 409/network failures back off instead of crashing the host. |
| `src/telegram.js` | Minimal Bot API client over `fetch` | JSON calls with 429 `retry_after` handling; `sendMessage` chunks plain text at the limit; `sendMarkdown` renders, chunks and sends an answer with `parse_mode: 'HTML'`, retrying that chunk once as plain text on a 400 "can't parse entities"; `sendChatAction` and `setMessageReaction` are thin `call` wrappers for presence; `message_thread_id` omitted for topic 0/General(1), carried for numbered topics. |
| `src/chunk.js` | 4096-char plain-text splitter | Joining chunks reproduces the input; code-point-safe (no split surrogate pair); prefers newline boundaries. |
| `src/render.js` | Markdown → Telegram HTML + tag-aware chunker | Renders only the tags Telegram accepts (`b`, `i`, `s`, `code`, `pre`, `a`, `blockquote`) and escapes `&`, `<`, `>` everywhere else; headings become bold lines; fenced code keeps an optional `language-x` class; chunks split on block boundaries first, then close and re-open open tags at a boundary so every chunk is balanced and at most `maxChunkChars` UTF-16 units, with no cut inside a tag or a surrogate pair. |
| `src/host.js` | Adapter over the host session service | `prompt`/`cancel`/`list`/`inspect` through the same Remote the GUI uses; one `AbortController` lifetime signal passed to `prompt`, `inspect` and `list`, aborted on `stop()`; history replay uses the cold-safe `inspect` Remote (the `page` fallback was removed — see below); visible user text from the v4 `data.content` + `data.source.kind === 'user'` shape; assistant finals (skips preambles with tool calls, interrupted/non-append events); reasoning blocks for verbose digests; replays the last final. `cancel` sends only `{sessionId}` — the 0.2.1 Remote rejects extra fields and applies `keepInbox:true` inside the host. |
| `src/util.js` | Shared helpers | `sleep` (abortable), `formatDuration`, `oneLine` digest trimming. |

Assistant final answers are the only rich surface. `src/render.js` converts
their Markdown to Bot API HTML and the chunker keeps `b`/`i`/`s`/`code`/`pre`/
`a`/`blockquote` balanced across the 4096-character boundary. Everything else
outbound — the `▸` user echo, `⚙`/`✎` digests, `⚠️` errors, approval and
question cards, the watchdog notice, and every `/command` reply — is sent
without `parse_mode`, so Markdown stays literal and HTML in user text is never
parsed. There is no config toggle: rich answers are the behavior. If Telegram
rejects a formatted chunk with 400 "can't parse entities", that chunk is retried
once as plain text and the fallback is logged, so content is never lost.

Presence is ephemeral and has no config toggle. A bound session's turn gets a
`typing` chat action in its topic every 4 seconds (Telegram clears the indicator
after about 5) and the user message that prompted it gets 👀, settling to ✅ on a
completed turn, ⚠️ on an error turn, and staying 👀 for `aborted`/`interrupted`.
Commands and unbound topics get no reactions. Both loops and reactions are
best-effort: failures are swallowed and logged at most once, so a Bot API hiccup
never loses a prompt or an answer.

`cordis.patch.yml` inserts the single row `telegram-session-bridge`; operator
steps (second bot, topics, token env, row config, commands, rollback) are in
[INSTALL.md](INSTALL.md).

## Durable event shapes (captured from real v4 logs, not invented)

Fixtures and parsers derive from real
`~/.dsh/sessions/<project>/session.v4.jsonl.zstd` records on 0.2.1-rc.5. The
shapes that matter:

- `user/message`: the payload **is** the message — `data.content`,
  `data.source.kind`, `data.role`; there is no `data.message`. Real traffic is
  dominated by synthetic sources (`runtime-context`, `time-context`,
  `openclaw-heartbeat`, `skill-catalog`); only `source.kind === 'user'` is a
  human turn (Telegram-originated prompts also use `user`).
- `assistant/message`: `data.message.content` is the part array; reasoning is a
  `{type:'reasoning', text}` block inside it (often followed by
  `{type:'text'}`). There is no durable `assistant/thinking` event.
- `turn/end`: failure is `data.reason = {kind:'error', error:{message, code}}`;
  completion is `{kind:'completed'}`; user/watchdog cancellations are
  `{kind:'aborted'|'interrupted'}`. There are no durable `turn/error` /
  `session/error` events.

An earlier revision hand-made fixtures with `data.message` and a fabricated
`assistant/thinking` event, so M6/M7 were green against payloads the host never
emits. `test/helpers/fixtures.js` now mirrors the captured records, the tests
include synthetic-source negative cases, and the M6/M7 tests fail if either
regression returns. Re-derive fixtures from a live session log before trusting a
new host version.

A user turn with no text block (image-only, `content` kinds `["image"]`) is not
echoed: the bridge is text-first and media is an MVP non-goal. This affected 4 of
621 real user turns in the sampled logs; the final answer still arrives, only the
`▸` echo of that input is skipped.

## In-host Remote calls need a signal (0.2.1-rc.5)

The RPC gateway injects the cancellation signal a Remote declares as
`cancellation: { parameter: 'signal' }` (`dsh-api-remotes` lib/client.js). An
in-host caller gets no injection, and the implementation does not guard:
`SessionController.prompt(request, signal)` calls `signal.throwIfAborted()`
unconditionally (`dsh-api-session-controller` lib/index.js:3219) — as does
`page(request, signal)` (lib/index.js:1486). Calling `prompt({...})` with one
argument therefore throws
`TypeError: Cannot read properties of undefined (reading 'throwIfAborted')` and
no turn ever starts.

`createHostAdapter` owns one `AbortController` per bridge, passes its signal to
`prompt`, `inspect` and `list`, and aborts it in `bridge.stop()` so a plugin
reload cancels in-flight Remote calls. The fake session controller enforces the
same `signal.throwIfAborted()` contract as the real signature, so a future
one-argument call fails the suite instead of reaching production;
`[transport] the host adapter supplies the AbortSignal the session Remotes
require` pins prompt, the inspect-backed replay, signal identity across calls,
and the abort on disposal.

`page` is no longer used for the replay, and not because of its signal: its
`throughSeq` must be the Session's current cursor, which only `inspect` (or a
follow snapshot) provides, and `page` rejects anything larger as
`gateway/bad-request … is past cursor …` (lib/index.js:1487). The previous
fallback sent `throughSeq: Number.MAX_SAFE_INTEGER`, so it could only ever throw,
and once `inspect` has returned the whole prefix `page` has nothing to add —
`inspect` is already the cold-safe path for persisted Sessions (lib/index.js:3046).
Removing the fallback also removed the dead `page` binding and fake method.

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
| M3 — host wiring: push envelopes, one-shot interaction waterfall, lifecycle | `[M3] apply subscribes to the host push envelopes and drives the real Bot API end to end`, `[M3] an unbound approval falls through next() to the native GUI answerer`, `[M3] disposing the host effect stops the watchdog and its timers`, `[M3] an approval request with no matching approval/asked event falls through`, `[M3] the bridge cancels through the host session Remote without extra fields` |
| M4 — safe failure modes: missing token, no eager state, corrupt/future state, unbound lobby | `[M4] a missing token disables the plugin without blocking host boot`, `[M4] loading creates no state and writes nothing until the operator binds`, `[M4] a corrupt state file is quarantined instead of silently overwritten`, `[M4] a future state version is rejected instead of rewritten`, `[M4] unbound lobby text is answered with instructions instead of entering a session` |
| M5 — approvals and questions claimed, answered once, otherwise fall through | `[M5] a bound approval is claimed from the push envelope and answered once`, `[M5] a bound approval is answered from a Telegram callback through the poller`, `[M5] rejecting is a one-shot rejection outcome`, `[M5] an aborted approval resolves cancelled and stops accepting presses`, `[M5] a bound question returns the selected labels to the host`, `[M5] a question with more than three options keeps every option answerable`, `[M5] a multi-select question toggles options and finishes on Done`, `[M5] an aborted question rejects with the host ASK_ABORTED code`, `[M5] an unbound approval falls through next() to the GUI`, `[M5] an unbound question falls through next()` |
| M6 — transcript parity, no duplicate echo of own prompts | `[M6] web-originated user turns and assistant finals keep transcript parity`, `[M6] synthetic loop context is never echoed to the topic`, `[M6] a prompt sent from Telegram is not echoed back as a duplicate`, `[M6] a different web turn is still echoed after one own prompt is consumed` |
| M7 — `/verbosity` per chat/topic, persisted, default quiet, higher levels add digests | `[M7] verbosity defaults to quiet per topic and persists across a reload`, `[M7] quiet delivers finals only; normal adds tool digests; verbose adds thinking digests`, `[M7] quiet still reports a failed turn from the durable turn/end reason`, `[M7] a higher level still delivers the final answer`, `[M7] /verbosity persists per topic across a bridge restart` |
| M8 — stall timeout → notice → `cancel{keepInbox}` (host-internal), recovery re-arms | `[M8] a stalled turn is notified and cancelled with the inbox kept`, `[M8] activity postpones the stall and a new prompt re-arms after recovery`, `[M8] unbound sessions are never watched`, `[M8] turn/start arms the watchdog for a turn with no human user message`, `[M8] turn/end disarms the watchdog through the delivery path`, `[M8] a failed prompt leaves no watchdog armed and reports the error` |
| Transport (supports M1/M6) — chunking, dedupe across restart, topic params, token isolation, Remote signal | `[transport] long assistant text is chunked at the Telegram limit without loss`, `[transport] chunking never splits a surrogate pair`, `[transport] duplicate updates are suppressed across a simulated restart`, `[transport] dedupe keys include both chat and thread`, `[transport] the General topic omits message_thread_id on send, numbered topics keep it`, `[transport] sendMessage and getUpdates carry the real Bot API parameters`, `[transport] tokenRef is an env credential and never dsh-im's bot identity`, `[transport] the host adapter supplies the AbortSignal the session Remotes require` |
| Rich output — Markdown→HTML, parse_mode scoping, tag-balanced chunking, plain fallback | `[rich] assistant Markdown is sent as Telegram HTML with parse_mode`, `[rich] fenced code renders as pre/code with its language`, `[rich] headings and blockquotes use only accepted tags`, `[rich] parse_mode is set only for answers; operational lines stay plain text`, `[rich] user content stays plain, and rendered prose escapes <script> and stray <b>`, `[rich] a long formatted answer is split into balanced chunks without loss`, `[rich] blank lines inside fenced code do not break block splitting`, `[rich] a split inside markup closes and re-opens tags across chunks`, `[rich] a 400 can't-parse-entities rejection retries once as plain text` |
| Presence — typing refresh and prompt reactions | `[typing] turn/start sends one action in the bound topic and refreshes every 4 s`, `[typing] a later turn re-arms the loop`, `[typing] repeated turn/start is idempotent: one loop, no duplicate immediate action`, `[typing] an unbound session never types`, `[typing] unbind stops the loop for that session`, `[typing] bridge stop clears a live loop and its timer`, `[reaction] a topic prompt gets 👀 on the user message and ✅ when the turn completes`, `[reaction] an errored turn swaps the eye for ⚠️`, `[reaction] a DM prompt gets 👀 on the user message and ✅ when the turn completes`, `[reaction] other endings leave 👀 in place and settle nothing later`, `[reaction] commands get none`, `[reaction] unbound topic text gets none`, `[reaction] a failing setMessageReaction is swallowed and the prompt still succeeds`, `[reaction] a failing turn/end reaction never blocks the turn error delivery` |
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

**Fixtures come from captured logs.** `test/helpers/fixtures.js` builds
`user/message`, `assistant/message`, `tool/call` and `turn/end` exactly like the
v4 records quoted above. Do not invent a payload to make a test pass: replay a
real session file first and confirm the shape.

**The fakes enforce the real signatures.** `FakeSessionController.prompt` calls
`signal.throwIfAborted()` like the 0.2.1-rc.5 prompt Remote does, so a
one-argument call rejects with the production error instead of silently passing.
The fake's `inspect` keeps its signal optional, matching the host; the fake has no
`page` because the bridge no longer calls it.

**keepInbox is the host's, not the bridge's.** The fake session controller
records the request the bridge sends (`{sessionId}`) separately from the
`agent.cancel({kind:'user'},{keepInbox:true})` its real implementation performs
internally, so `[M3] the bridge cancels through the host session Remote…`
asserts the bridge's request shape rather than the fake's flag.

No real credentials, no network, and no live DSH instance are needed for the
tests.
