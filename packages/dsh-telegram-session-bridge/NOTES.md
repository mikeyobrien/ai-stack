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

## Layout

- `src/` — host plugin source (zero runtime deps)
- `test/` — `node --test`, fake host + fake Bot API on 127.0.0.1
- `cordis.patch.yml` — service row for the host bundle
- `INSTALL.md` — operator steps; `NOTES.md` — this file
