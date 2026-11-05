# dsh-usage-metrics

A **Metrics** entry in the global left sidebar. It opens one panel with two
lists — skills and principles — where each row is one name with the number of
times the agent successfully called that tool for it.

## What the number is

A count of **successful recorded tool invocations** of the `skill` tool and the
`principle_read` tool, per skill and per principle, **from the moment this plugin
was activated**. Nothing is backfilled: the Host listens to the live
`session/event` append feed, so the first number is the first invocation after
activation.

- only `tool/call` events whose tool name is `skill` or `principle_read`;
- only calls with a matching recorded `tool/result` whose `message.isError` is
  not `true` and that carries no error — missing, cancelled, interrupted and
  failed calls are not counted;
- a fork or resume inherits its parent's events as a seed, and seed events never
  publish on the append feed, so an inherited copy cannot be counted at all;
- one invocation is one session's call id: a repeated identical event pair in
  that session is ignored, while the same call id in another session is a
  distinct invocation;
- not mentions, not chat self-reports, not "the agent probably applied this".

The row name is the canonical name recorded by the tool itself:

| Tool | Row name | Fallback |
| --- | --- | --- |
| `skill` | `<skill_content name="…">` in the result | the call's `name` argument |
| `principle_read` | the `name: … · version: …` line in the result (so an alias resolves to its principle) | the call's `name` argument |

Rows are sorted by count, highest first, then by name.

## Scope

The feed covers every session this Host runs from activation onward — all
workspaces and subagent sessions — but never anything before it. The panel says
when counting began ("since 3 Nov 2026") instead of implying an all-time total.

Counting is scoped to the profile that runs the plugin: each profile keeps its
own small JSON document under the DSH home (`usage-metrics/state-<profile>.json`,
taken from the Host's `--profile` argument), so two profiles cannot clobber each
other's numbers. A one-time adoption moves the earlier home-wide `state.json`
into the running profile's file so counts recorded before this scoping keep
counting. A restart continues the count and keeps the original start date.

A call whose result lands after the Host restarts is not counted, because its
pending call record died with the previous process. A malformed state file
starts a fresh count at activation, which the panel then reports honestly.

Only names, counts, and the start date travel to the browser: no transcripts,
no arguments, no session ids. Nothing is written to the session logs, and
opening or refreshing the panel cannot change a count.

## Acceptance checks

Written before the code. Each is observable without reading source.

1. I click **Metrics** in the existing left sidebar and see separate named
   skills and principles with numeric invocation counts.
2. An isolated known successful skill call and principle call each raise their
   canonical row by exactly one. Failed, cancelled and result-less calls,
   inherited copies, page refreshes and viewing the panel raise nothing.
3. The panel states the day counting began, so it never claims history it was
   not running for.
4. Loading, empty, long names, keyboard operation, light/dark, desktop and
   390px layouts are usable.
5. Existing Agent and ordinary session panels, other sidebar panels, and
   delegations are unchanged.

## Install

The `dsh/profile/package.json` in this repository lists the bundle. To install
it into another profile, use `plugin_manager` with action `install_bundle` and
the package directory as the target.
