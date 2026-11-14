# @local/dsh-llm-claude-code

Native Claude Code model provider for DSH. The official `claude` CLI
(authenticated with your normal `claude auth login`) is used purely as transport and
authentication for one model call at a time; **DSH keeps the agent loop, tool
execution, approvals, history, compaction, and streaming**. This is not the
subagent launcher (`@deepseek-ai/dsh-subagent-claude-code`) — it makes Claude
models selectable as the conversation model.

## How it works

- Each model call spawns a fresh `claude -p` worker with `--input-format/--output-format
  stream-json`, `--max-turns 1`, `--permission-mode dontAsk`, no settings
  sources, no slash commands, and `--tools ""` (built-in CLI tools disabled).
- DSH tools are advertised through one deliberately inert local MCP server
  (`inert-mcp.mjs`): it answers `tools/list` only; `tools/call` is denied by
  construction, so the CLI can never execute a tool behind DSH's approval path.
- A loopback HTTP relay (`127.0.0.1`, random secret path) intercepts
  `ANTHROPIC_BASE_URL`, forwards exactly one `POST /v1/messages` per turn to
  the Anthropic API with a canonically rebuilt body (DSH history, one stable
  cache breakpoint at the conversation tip), streams the raw SSE back to the
  CLI, and hands the parsed events to the adapter. Any other route, and any
  second request in the same turn, is refused. The CLI's own request headers
  (user-agent, auth, betas) pass through unchanged, and the upstream response
  headers (including rate limits) go back to the CLI. Auth headers transit
  memory only; nothing is logged or persisted.
- Stop, timeout, or a CLI that exits early cancels the upstream request, so an
  abandoned turn stops generating.
- History is replayed as stream-json frames; there is no `--resume` session
  reuse, so two sessions can never cross-contaminate.
- Model metadata comes from the CLI's own `control_response` catalog
  (verified on 2.1.316); the static list is a labeled last resort.

## Enable

Opt-in: add `@local/dsh-llm-claude-code` to `dsh/profile/package.json`
(`dependencies` as `link:@REPO@/packages/dsh-llm-claude-code`, and `bundles`),
then run `./install.sh dsh`. It needs the official `claude` CLI logged in with a
Claude subscription (`claude auth login`).

## Configuration

| key | default | meaning |
|---|---|---|
| `command` | `claude` | CLI executable. If `claude` on PATH is a version-manager shim (mise's `~/.local/bin/claude` mutates global tool state), set the resolved binary in your profile's `cordis.patch.yml`. |
| `configDir` | — | optional `CLAUDE_CONFIG_DIR` for the child only. |
| `requestTimeoutMs` | `180000` | longest silence (no SSE event or CLI output) before the turn fails with `TIMEOUT`. |
| `statusTimeoutMs` | `20000` | ceiling for `auth status`. |
| `allowUsageCredits` | `false` | permit usage-credit billing instead of failing the turn. The check reads the CLI's `rate_limit_event` (`isUsingOverage`) after the response, so the request that crossed the limit is already charged; failing stops the loop from sending more. Subscription billing for `claude -p` can change; nothing here guarantees no-overage. |

The child environment strips `ANTHROPIC_API_KEY` (parent env untouched) and
refuses to start when `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` are set, so
billing can never silently reroute. The login check (`claude auth status`) runs
with the same stripped environment. The plugin never reads credential files;
login is the official `claude auth login`.

Upstream failures carry the shared DSH codes: `RATE_LIMIT` (with
`retry-after`), `SERVER` (5xx, overloaded), `CONTEXT_WINDOW_EXCEEDED`
("prompt is too long"), `AUTH`, `QUOTA`, `BILLING` (Anthropic moving the
request to usage credits), `INVALID_REQUEST`, `TRANSPORT`, `TIMEOUT`. A CLI
that exits before making a request fails as `CLI_FAILED` with its own error
text. System prompts must stay under 128 KiB (one argv string).

## Status / limits (experimental)

- Subscription billing behavior is Anthropic's to change; `claude -p` usage is
  subject to plan limits.
- Multimodal INPUT: user/tool history images are sent as Anthropic base64
  blocks (requestImageHandleText note preceding each image) through both the
  CLI frames and the canonical relay body; the adapter transport bound is
  8 MiB accumulated base64 per request with 4 MP / 1 MiB per-image targets —
  over-budget requests fail `IMAGE_OFFLOAD_REQUIRED` so DSH can offload and
  retry, never silently dropped. No image OUTPUT (text responses only).
  Native signed/redacted thinking round-trips through `replayState`; reasoning
  from other providers is omitted rather than given fabricated signatures.
- First version uses a fresh process per call; no warm-worker cache.
- Only subscription (`claude.ai`) logins are accepted; a stored API-key login
  is refused with an actionable error instead of silently spending metered
  credits (the child env strips `ANTHROPIC_API_KEY`, so key billing would
  otherwise be invisible).

## Attribution

Behavior modeled on [`earendil-works/pi-claude-code`](https://github.com/earendil-works/pi-claude-code)
(commit `d5b5e04c314d3452d357174d16d10dda34daa2d2`), MIT License,
Copyright (c) 2026 Armin Ronacher. This is a reimplementation against
documented interfaces, not a copy of its source; the license text applies to
any substantial ported expression:

```
MIT License

Copyright (c) 2026 Armin Ronacher

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
