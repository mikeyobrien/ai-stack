# dsh-notifier

Pushover pushes for long work: when a long agent turn finishes, when a task on
the list completes, and when a goal reaches a terminal phase.

```text
✅ ai-stack · 4m 32s

Goal: Add dark mode to the settings page.

Dark mode is implemented in Settings; tokens follow the system theme. Build and
typecheck pass.

18 tool calls · 2 failed · 42.1k tokens
```

```text
☑️ ai-stack · task 3/7
Done: Build the parser tests.

3 of 7 complete.
```

```text
🎯 ai-stack · goal complete
Objective: Ship the parser rewrite.

3 rounds · 42m
```

The summary is built from events the turn already committed — the request that
opened it, the last words the model wrote, its tool work, and the time it took.
Only a human's own words open a turn's goal line: an automatic goal-round
continuation carries the goal's real objective from a `goal/change` snapshot
the plugin has seen (or no goal line when it has not), and notices, relays,
and job reports are never read as a request. Task and goal pushes come straight
from the durable `todo/write` and `goal/change` events. No model call is made
for a notification, so it costs no tokens and arrives the moment the work
lands.

The closing summary is Markdown in the chat view, but a push has no renderer, so
`**bold**`, backticks, headings, and table pipes are flattened to plain text
before sending — links keep their label, code keeps its code, and `snake_case`
survives. Every push also carries the GUI URL as Pushover's `url` with the label
`Open session`, naming the session it is about (`?session=<id>`) when the host
serves a web app. The `@local/dsh-session-links` bundle is what makes that link
open the thread; without it the parameter is ignored and the app opens.

## Enable

The bundle is `@local/dsh-notifier`. Install it from this checkout:

```sh
dsh plugin --profile web add ./packages/dsh-notifier
```

`cordis.patch.yml` inserts the `notifier` row. Override that row's `config` from
a profile patch to retune it:

```yaml
- id: notifier
  config:
    minDurationSeconds: 300
```

## Credentials

Two credential references, resolved at each send, never stored in config:

| Reference | Default | Meaning |
| --- | --- | --- |
| `tokenRef` | `PUSHOVER_TOKEN` | the Pushover application token |
| `userRef` | `PUSHOVER_USER` | the user or group key |

They resolve through `ctx.credentials`, so any layer works: a key saved in the
credential store (takes effect without a restart), the environment DSH was
launched in, the project's `.env`, or `$DSH_HOME/.env`. The store is the usual
place; add both references under `refs:` and it reloads the file itself:

```yaml
refs:
  PUSHOVER_TOKEN: <application token>
  PUSHOVER_USER: <user or group key>
```

Notification is skipped with a `[dsh-notifier] … not configured` stderr line
while either reference is unset.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `minDurationSeconds` | `120` | shortest turn that earns a push |
| `includeSubagents` | `false` | also notify for delegated child sessions |
| `notifyTasks` | `true` | push when a task-list item moves to `completed` |
| `notifyGoals` | `true` | push when a goal becomes `complete` or `blocked` |
| `priority` | `0` | Pushover priority; `-2` to `1` (`2` is refused — it repeats until acknowledged) |
| `sound` | — | Pushover sound name |
| `device` | — | restrict to one device name |
| `tokenRef` | `PUSHOVER_TOKEN` | credential reference for the application token |
| `userRef` | `PUSHOVER_USER` | credential reference for the user/group key |

## Behavior

- A turn is "long" when `turn/end` arrives at least `minDurationSeconds` after
  `turn/start`. A turn that began before the plugin loaded has no start time and
  is not notified.
- A task-list write pushes once for the items it moved to `completed`, listing
  them and the new progress (`☑️ ai-stack · task 3/7`). A rewrite that completes
  nothing is silent, and the first snapshot after activation is only a baseline.
- A goal pushes when its phase reaches `complete` or `blocked`, with the
  objective, admitted rounds, elapsed time, and the block reason
  (`🎯 ai-stack · goal complete`). Other operations (create, edit, pause, resume,
  clear) are silent.
- `forked` turn ends are skipped: the session continues in the child, so nothing
  finished.
- A goal line shows a human request, or the goal's real objective from the
  last `goal/change` snapshot the plugin has seen for the session; a turn
  opened by automation (a goal round) with no such snapshot carries no goal
  line. Automatic continuations, injected notices, and relays are never read
  as a request.
- Subagent and workflow sessions carry `origin: 'subagent'` and stay silent
  unless `includeSubagents` is set.
- A failed turn titles itself `⚠️ <project> failed` and puts the failure on the
  first line.
- The title is bounded to Pushover's 250 characters and the body to 1024, both
  counted in code points. The goal line and the model's closing summary survive
  truncation; excess closing text is cut at a word boundary.
- Deliveries run one at a time (Pushover allows two concurrent connections).
  Connection errors and 5xx responses retry after 5 s and 10 s; a 4xx or a
  `status !== 1` answer is final. Each accepted send logs its Pushover request
  id and attempt count (`[dsh-notifier] accepted after N attempt(s), Pushover
  request <id>`), so a delivery can be traced without exposing credential
  fields. Nothing blocks or fails the turn; delivery problems are written to
  stderr as `[dsh-notifier] …`.

## Test

```sh
pnpm --filter @local/dsh-notifier test
```

The suite drives the real `apply()` with synthetic session events against a
recording fetch, and checks the transport against a fake endpoint. Real Pushover
delivery additionally needs the two credentials above.
