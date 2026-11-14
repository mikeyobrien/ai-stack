# @local/dsh-tool-discovery

A fresh session should not pay for a large MCP catalog before the model asks for
it. This bundle hides a configured tool-name prefix from every agent's own scope
and exposes one small `tool_search` tool. Tools the model explicitly selects
become natively callable on the next step; the rest never reach the wire.

## Behavior

- **Hide.** For every existing and newly created agent, the plugin calls
  `agent.ctx.tools.restrict({ deny })` with every global tool carrying `prefix`
  that the agent has not activated. Restriction removes inherited tools only, so
  foreign restrictions stay in force and core tools stay visible.
- **Find.** `tool_search` synchronously lifts *only this plugin's own*
  restriction for the caller, reads `ctx.tools.schemas(scope)` with the caller's
  scope (so anything another feature denied is absent), and restores its own
  restriction before returning. No await can observe the lifted window. The
  query is split into words (and `snake_case` parts); a name match counts more
  than a description match, and tools that match no word are left out.
- **Activate.** `select` REPLACES the session's active set; pass every tool you
  need for the task together. Omitting `select`, or passing an empty list, only
  searches. The whole set is validated and applied atomically:
  unknown names, a set larger than `maxActive`, or a set over `maxSchemaBytes`
  is rejected with no state change. The agent's deny list is then recomputed
  without the accepted names. The original `ToolDefinition` is untouched, so
  identity, input validation, permission guards, concurrency class,
  cancellation, and side effects are the native ones.
- **Rollback.** An activation is staged against the agent and call that applied it. The
  native `tools/result` is the final frozen outcome, so a call whose committed
  result is an error — a cancellation, or a policy failure after the body ran —
  is rolled back to the previous set. Live state always matches what the log
  will replay.
- **Durable.** A successful call publishes its committed set through
  `output.presentationMeta`, which the agent loop commits as
  `tool/result.data.meta`. A host-only `ctx.sessionProjections` unit folds that
  metadata for tool-call ids it saw in `assistant/message`, so resume, fork, and
  replay rebuild the active set from the log. Replay never trusts the names a
  model asked for: a refused, oversized, unknown, failed, or cancelled call
  carries no metadata and cannot change the selection.

## Config

```yaml
config:
  prefix: 'mcp__rea__'      # tool-name prefix to hide (non-empty; never hides tool_search)
  select: []                # default active set until a session selects its own
  maxResults: 8             # matches returned by one search
  maxActive: 8              # hard cap on the active set
  maxSchemaBytes: 16384     # hard cap on the active set's total schema bytes
  maxCandidateChars: 200    # per-candidate description bound
```

`maxActive` and `maxSchemaBytes` bound the *whole* active set, not one response,
so repeated searches cannot grow the wire. A selection that would exceed either
is rejected atomically with an actionable `error`; no partial set is ever
applied and no schema is returned for it.

## Failure behavior

A registration burst (an MCP server loading a large catalog) is coalesced into
one enforcement pass on the next turn of the event loop, and each pass reads the
catalog once and reuses that snapshot for every live agent, so the cost does not
scale with tools times agents. `agent/created` still enforces synchronously,
before the first prompt. Unloading the plugin cancels any queued pass, so
teardown cannot leave orphan restrictions behind.

Every path that can change an active set — a new selection, a cold restore, and
a provider re-registering a tool — runs the same budget check against the
schemas registered right now. A saved set that no longer fits is dropped: the
catalog stays hidden, `tool_search` stays available, and a new bounded selection
works normally. A saved tool that is not registered yet is kept, not dropped: an
MCP server often registers its catalog shortly after a session resumes, and the
next enforcement pass makes the saved tools visible.

Hiding never opens a window. A new restriction is installed before the previous
one is dropped, so a failure keeps the last safe restriction instead of exposing
the catalog; the failure is logged and reported in the tool result. Creating an
agent whose catalog cannot be hidden throws an actionable error rather than
starting the session with the full catalog visible. If the restriction cannot be
restored after a search's read window, the call fails, the failure is logged,
and the next enforcement pass re-installs the restriction.

## Install

From a source checkout of this workspace:

```
plugin_manager install_bundle target=<checkout>/packages/dsh-tool-discovery
```

The bundle declares optional peer dependencies on the Harness packages it
imports; they resolve from the DSH installation.

## Tests

```
node --test test/*.test.js
```

The suite drives a real Cordis `Context`, a real `ToolRuntime`, real `dsh-scope`
scopes, and the real `SessionProjectionRegistry`. The prompt assembler, the
agent registry and each agent's session object are stand-ins.

The runtime dependencies (`@deepseek-ai/cordis`, `dsh-scope`, `dsh-tools`,
`dsh-session-projection`, and `zod`) are declared as optional peer dependencies
and resolve from the DSH installation.

## Limitations

- The durable fold recognizes `tool_search` calls by the canonical
  `assistant/message` and `tool/result` shapes plus this plugin's versioned
  `meta` payload. A transport that never commits `meta` would fail to replay.
- `select` replaces rather than accumulates; a caller that wants a larger set
  must select it in one call, bounded by `maxActive` and `maxSchemaBytes`.
- Activation is scoped to one session's agent. A fork starts from the parent's
  log, so it inherits the parent's activation set.
- The plugin hides a name prefix; it does not cap a catalog by count or classify
  tools by origin.
