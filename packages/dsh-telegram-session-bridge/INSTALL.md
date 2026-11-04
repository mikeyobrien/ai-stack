# Install — dsh-telegram-session-bridge

In-host DSH plugin: one Telegram forum topic per DSH session. It rides the
host's own push envelopes (so it needs no core changes and no HTTP hop to the
session service) and talks to Telegram over the Bot API with **its own bot
identity** — never dsh-im's token. Zero runtime dependencies.

Verified against `@deepseek-ai/dsh` 0.2.1-rc.5. Internals and the M1–M8 test
matrix live in [NOTES.md](NOTES.md).

## Before you start

- DSH installed and runnable as `dsh`; the examples use profile `web`.
- This checkout, with `packages/dsh-telegram-session-bridge` present.
- Node 22+ (`node --test` is the only test tool).
- `dsh` and `pnpm` on `PATH` for profile installs.
- A Telegram account that can create a bot and DM it.

## 1. Create the bridge bot

The bridge must not share dsh-im's bot token: two long-polls on one token
conflict (409) and one side silently loses updates.

1. In **@BotFather**: `/newbot`, pick a name and a username ending in `bot`,
   keep the token.
2. Enable topics for that bot: `/mybots` → the bot → **Bot Settings** →
   **Topics** → turn on. The bot reports `has_topics_enabled` in `getMe`; the
   bridge logs a warning at boot when it is `false`.
3. Open the DM with the bot, turn on Topics for that chat if your client hides
   them, and create one topic per session you want on Telegram. The bridge never
   creates or deletes topics; a topic is the address it binds.

## 2. Put the token in the environment

The token is read only from the environment variable named by `tokenRef`
(default below). The bridge never reads another plugin's config and never stores
the token in its state file.

```sh
export DSH_TELEGRAM_SESSION_BRIDGE_BOT_TOKEN='123456:ABC...'
```

Put that export in the environment that starts `dsh` — shell profile, systemd
unit, launchd, container env — not in the profile YAML. A different variable
name is fine via `tokenRef` (step 4); it must be an env var name, and a name
pointing at dsh-im is rejected on purpose.

If the variable is missing, the plugin logs
`[telegram-session-bridge] disabled: env var … (tokenRef) is not set` and DSH
boots normally. Nothing else runs and no state is written.

## 3. Wire the bundle into the profile

The package ships its own `cordis.patch.yml`; being listed in
`dsh.profile.bundles` is what makes that row run. Pick one path:

### A. This host's live profile (recommended)

Edit `~/.dsh/profiles/web/package.json` (i.e. `$DSH_HOME/profiles/web/`):

```json
{
  "dependencies": {
    "dsh-telegram-session-bridge": "link:/home/mobrienv/dsh-workspace/ai-stack/packages/dsh-telegram-session-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "… existing bundles …",
        "dsh-telegram-session-bridge"
      ]
    }
  }
}
```

Then install the profile's dependencies:

```sh
dsh plugin --profile web install
```

### B. Repo-managed, for fresh profiles

Add the package to `dsh/profile/package.json` dependencies as
`"dsh-telegram-session-bridge": "link:@REPO@/packages/dsh-telegram-session-bridge"`,
add the name to `dsh.profile.bundles`, then `PROFILE=<name> ./install.sh dsh`
(resolves `@REPO@` to this checkout).

> Do not point `install.sh` at an already-customised profile such as `web`
> just for this plugin: it replaces the profile's `package.json` with the repo
> copy (backing up the old one), which would drop rows that only exist there.

## 4. Configure the row

Add this to `~/.dsh/profiles/web/cordis.patch.yml` — the bundle inserts the row,
and this same-id entry configures it:

```yaml
- id: telegram-session-bridge
  name: dsh-telegram-session-bridge
  config:
    allowedChatIds: [123456789]   # your Telegram user id; required, fail-closed
    # tokenRef: DSH_TELEGRAM_SESSION_BRIDGE_BOT_TOKEN
    # stallTimeoutMs: 900000      # 15 min default
    # pollTimeoutSec: 25          # long-poll window, 0–50
    # maxChunkChars: 4096         # Telegram's text limit; lowering works, raising does not
    # baseUrl: https://api.telegram.org
    # dshHome: /home/you/.dsh     # state parent dir override
    # poll: true                  # false stops inbound Telegram, not delivery
```

`allowedChatIds` is fail-closed: empty or absent means every chat is ignored.
Find your id by DMing the bot once and reading
`ignoring chat <id>: not in allowedChatIds` from the DSH log (or ask
@userinfobot). Keep the list to your own account.

State lives at `$DSH_HOME/telegram-session-bridge/state.json` (default
`~/.dsh/telegram-session-bridge/state.json`), mode `0600`, replaced atomically.

## 5. Restart and verify

Restart `dsh --profile web` — the token env var is read at process start.

```sh
dsh --profile web --dump-config | grep -A8 telegram-session-bridge
```

Logs:

- A `disabled:` line means the plugin is off; it names the exact fault (missing
  token, invalid `tokenRef`, unreadable/newer state file).
- `getMe failed; continuing` is non-fatal, but it usually means a bad token or
  no network; expect poll failures right after it.

In Telegram:

1. DM the bot, open one of its topics, send `/help`.
2. `/sessions` lists DSH session ids (with titles when the host has them).
3. `/bind <session-id>` binds this topic; binding an existing session replays its
   last visible assistant answer (`↩︎ Restored …`). `/new` creates a fresh one.
4. Send plain text in the topic to prompt that session. Everything the session
   produces is addressed by the binding — the model never picks the chat.

Approvals and questions arrive as cards with inline buttons. The first press
settles them once; later presses answer "no longer active" and the card is
edited to the outcome. Question options wrap three per row, so every option is
answerable. Unbound sessions' cards stay in the web GUI.

A bound turn with no session activity for `stallTimeoutMs` posts
`⌛ No activity for 15m…` and the host cancels the turn keeping the queued
inbox. A turn is watched from its `turn/start` — including goal and heartbeat
turns that no operator prompt started — and the next turn re-arms it. Activity
extends the timer, and `turn/end` disarms it.

## 6. Commands

Send in the bound topic unless noted.

| Command | Effect |
| --- | --- |
| `/bind [session-id]` | Bind this topic to a session; without an id, list sessions. Rejects the DM lobby. |
| `/new` | Create a session through the host and bind it here (replaces the topic's old binding). |
| `/unbind` | Detach this topic and drop its verbosity override. |
| `/verbosity [quiet\|normal\|verbose]` | Read or set the output level for this chat/topic; persists across restarts. Works in the lobby too. |
| `/sessions` | List host sessions. |
| `/status` | Current session and verbosity for this topic. |
| `/help`, `/start` | Command summary. |

Verbosity levels (default **quiet**, persisted per `(chat, topic)`):

| Level | Adds |
| --- | --- |
| `quiet` | Assistant finals, approvals/questions, failed-turn warnings (`⚠️ …` from a `turn/end` error reason), the watchdog notice, restore replay. |
| `normal` | One-line tool-call digests (`⚙ …`). |
| `verbose` | One-line reasoning digests (`✎ …`) from the assistant message's reasoning blocks. |

Human user turns from the web GUI are echoed as `▸ …`; synthetic loop context
(runtime/time context, heartbeats, skill catalogs) is never echoed, and a prompt
you sent from Telegram is not echoed back twice. An image-only user turn has no
text to echo (the bridge is text-first), but its final answer still arrives.

## 7. Rollback

1. Remove `dsh-telegram-session-bridge` from `dsh.profile.bundles` (and the
   dependency) in the profile, run `dsh plugin --profile web install`, restart.
   Setting `poll: false` instead only stops inbound Telegram — delivery and
   approval claiming keep running.
2. The state file is inert without the plugin. With DSH stopped, back it up
   (`cp state.json state.json.bak`) or delete
   `$DSH_HOME/telegram-session-bridge/` to forget bindings, verbosity and the
   update offset. Deleting it while DSH runs will be overwritten by the next
   write.
3. Nothing in DSH sessions, the GUI, dsh-im's token, or dsh-im's state is
   touched. Telegram topics remain; delete them in the app if you are done.

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `disabled: env var … (tokenRef) is not set` | Export the token in the environment that starts DSH, then restart. |
| `disabled: tokenRef must not point at dsh-im's bot identity` | Rename the variable; the bridge refuses dsh-im's token by design. |
| `bot reports has_topics_enabled=false` | @BotFather → `/mybots` → Bot Settings → Topics. |
| Bot ignores every message | `allowedChatIds` is empty or missing your id; the log shows `ignoring chat <id>`. |
| `409` / repeated poll failures | Another process long-polls the same token (a second bridge, dsh-im, or a script). One poller per token. |
| No reply in a topic | `/status`; an unbound topic answers with instructions, and `/bind`/`/new` refuse the DM lobby. |
| No approval card | That session is not bound to the bridge; unbound requests stay in the GUI by design. |
| Restore has no replay | The host had no visible assistant text to replay; the binding was still applied. |
| `state.json.corrupt-<ts>` appears | The store was unparseable and was quarantined (bindings/verbosity reset). Restore a backup while stopped and inspect the file. |
| Newer `state.json` version | The bridge refuses to touch a future version and stays disabled; install the matching plugin version instead of downgrading the file. |

## Coexistence with dsh-im

- A second bot identity: never dsh-im's token, never dsh-im's config.
- Claims approvals/questions only for sessions bound to this bridge; every other
  request falls through `next()` to dsh-im or the GUI.
- A separate state file; it never reads or mutates DSH core or dsh-im stores.
- Both can run at once, and the web GUI remains the fallback answerer.
