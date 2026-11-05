# dsh-llm-concurrency

Queues model requests past a provider's concurrency ceiling instead of failing
them.

## Why

The sparks gateway serves four concurrent generations. The fifth simultaneous
request is rejected regardless of which Session sent it: a parent turn, eight
subagents, a session-title call and a compaction summary all draw from the same
four slots. Nothing higher in the stack can see that number — `maxActiveSubagents`
counts *children*, not requests — so the ceiling used to surface as provider
errors whenever enough work overlapped.

## How

`llm/stream` is the one waterfall every model request passes through: loop-built
turns, one-shot titles, compaction, session queries, and prepared calls alike.
This plugin listens there, admits a request only when its provider has a free
slot, and releases the slot when the stream ends, throws, or is aborted.

Waiting is FIFO and abortable. A cancelled turn leaves the queue instead of
holding a position; a stream the consumer abandons (`break` out of the loop)
still returns its slot. Requests to unconfigured providers are not wrapped at
all — no queue, no wrapper, no latency.

Because the limit is keyed on the provider serving the request, it covers every
sender on that provider: the subagent cap can stay at its breadth value, and
extra children queue at the request boundary rather than failing with
`ACTIVATION_LIMIT_REACHED`.

## Configuration

Row `llm-concurrency` (see `cordis.patch.yml`):

```yaml
- id: llm-concurrency
  name: '@local/dsh-llm-concurrency'
  config:
    rules:
      - provider: sparks        # registered provider id
        maxInFlight: 4          # simultaneous requests
        models: []              # optional; empty/omitted means every model
```

Config is validated at load: unknown keys, a duplicate provider, a non-positive
`maxInFlight`, or an empty provider id fails the boot with a message naming the
offending rule.

## Verification

`node --test test/*.test.js` covers the observable behavior: peak overlap equals
the ceiling, admission order is FIFO, a failing request returns its slot, an
aborted waiter never reaches the provider, an abandoned stream releases, model
filters apply, and unconfigured providers are passed through untouched.

Live check: boot the profile and grep the journal for
`llm-concurrency: provider "sparks" limited to 4 simultaneous requests`, then run
more than four overlapping requests on that provider and look for the admission
line reporting `peak 4`.
