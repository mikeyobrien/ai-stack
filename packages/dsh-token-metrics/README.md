# dsh-token-metrics

A **Token Metrics** entry in the global left sidebar. It opens one panel with
a per-model table: each row is one model name and the token counts of the
calls it ran, plus a totals line.

## What the numbers are

The token usage of every settled `assistant/message` — the `TokenUsage` each
model adapter reported for that call — **from the moment this plugin was
activated**. Nothing is backfilled: the Host listens to the live
`session/event` append feed, so the first row is the first call after
activation.

- only `assistant/message` events that carry a `usage` field; a call with no
  reported usage adds nothing;
- rows are keyed by the model name the call was attributed to
  (`message.source.model`);
- `inputTokens` is uncached input only. Cached input is reported separately as
  `cacheReadTokens` / `cacheWriteTokens`, so the "Cache read" column shows how
  much of the prompt was a cache hit;
- `outputTokens` is new generated text, and `reasoningTokens` (where the
  adapter reports it) is the thinking tokens inside it;
- a fork or resume inherits its parent's events as a seed, and seed events
  never publish on the append feed, so an inherited copy cannot be counted at
  all;
- a repeated identical event in one session is one call — not double-counted.

No price is computed. The counts are raw token numbers, so a free local model
and a paid remote one are both shown as tokens, and the reader can compare
them without a rate assumption.

## Scope

The feed covers every session this Host runs from activation onward — all
workspaces and subagent sessions — but never anything before it. The panel
says when counting began ("since 3 Nov 2026") instead of implying an
all-time total.

Counting is scoped to the profile that runs the plugin: each profile keeps its
own small JSON document under the DSH home
(`token-metrics/state-<profile>.json`, taken from the Host's `--profile`
argument), so two profiles cannot clobber each other's numbers. A restart
continues the count and keeps the original start date.

Only model names, token counts, call counts, and the start date travel to the
browser: no transcripts, no prompts, no arguments, no session ids. Nothing is
written to the session logs, and opening or refreshing the panel cannot change
a row.

## Acceptance checks

Written before the code. Each is observable without reading source.

1. I click **Token Metrics** in the existing left sidebar and see a per-model
   table with calls, input, cache-read, output and total token columns, plus a
   totals line.
2. A settled model call with a usage field raises its model's row by exactly
   its reported counts. A call with no usage field raises nothing. Failed or
   result-less calls raise nothing.
3. The panel states the day counting began, so it never claims history it was
   not running for.
4. Loading, empty, long model names, keyboard operation, light/dark, desktop
   and 390px layouts are usable.
5. Existing Agent and ordinary session panels, other sidebar panels, and
   delegations are unchanged.

## Install

The `dsh/profile/package.json` in this repository lists the bundle. To install
it into another profile, use `plugin_manager` with action `install_bundle` and
the package directory as the target.
