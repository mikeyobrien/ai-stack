---
name: restart-dsh
description: "Use when the DSH Web service must be restarted — after adding profile rows, installing a plugin the running process cannot adopt, or changing the unit — including the detached scheduling that keeps the reply deliverable when the agent itself is running inside that service."
---

# Restart DSH

## Why

The agent runs inside `dsh-web.service`. A plain `systemctl --user restart` kills the
process hosting the conversation mid-turn: the tool call never returns, the reply is
never delivered, and the WebSocket drops. The restart still happens, which makes it
look like it worked while the user sees a dead turn.

Restarting is also the only way to load things the running process cannot adopt:
a newly composed provider, a new MCP server, or an edited unit. YAML row toggles in
a profile with HMR recompose live; providers and unit files do not.

## What

A restart that happens after the reply is sent, plus the checks that confirm the new
process actually came up with the intended composition.

## How

1. **Confirm what is running.** The unit, its profile and its port:

   ```sh
   systemctl --user status dsh-web.service --no-pager | head -5
   cat ~/.config/systemd/user/dsh-web.service
   ```

   Expect `dsh --profile web --no-open --port 3080`, with `dsh-auth-proxy.service`
   bound to it (`BindsTo=dsh-web.service`, serving `127.0.0.1:3081`).
2. **Restart both, detached, a few seconds out.** `systemd-run` puts the command in
   its own transient unit, outside the cgroup that is about to be killed:

   ```sh
   systemd-run --user --collect --unit=dsh-restart-oneshot \
     --description="one-shot dsh restart" \
     /bin/sh -c 'sleep 4; systemctl --user restart dsh-web.service dsh-auth-proxy.service'
   ```

   The sleep is not politeness — it is the window in which the current turn finishes
   and its reply reaches the browser. Do not use `nohup`/`setsid` for this: a child
   that sleeps first stays inside `dsh-web.service`'s cgroup, so the unit's own stop
   kills it before the sleep elapses and the restart never fires. A transient unit
   lives outside that cgroup. Confirm it is queued with
   `systemctl --user status dsh-restart-oneshot.service`.
3. **Include the auth proxy.** It is `BindsTo` the web unit, so restarting the web
   service tears it down; naming it in the restart keeps the order right and avoids a
   window where the public URL has no backend.
4. **Expect the turn to end there.** The page reconnects on its own and the session
   resumes from persisted history. Anything that was mid-flight in the old process —
   a running job, a streaming turn — does not survive.
5. **Verify from the next turn.** `systemctl --user is-active dsh-web.service`, then
   `systemctl --user status … | head -8` for uptime and memory, and confirm the
   capability you restarted for is actually present (a new tool in the toolset, a new
   MCP server, the changed flag in `ps`).
6. **Diagnose a failed start before retrying.** `journalctl --user -u dsh-web.service
   -n 50 --no-pager`; `systemctl --user reset-failed dsh-web.service` clears a
   start-limit block. A bad profile row fails loudly in the journal, not in the UI.

### Questions

- Does this need a restart at all, or would a profile recompose have covered it? HMR
  handles row-level YAML edits in a running composition; new packages, providers and
  `cordis.patch.yml` inserts are the cases that need the boot.
- Is the unit the right thing to change, or the profile it points at? Editing the unit
  needs `systemctl --user daemon-reload` before the next start.

### Gotchas

- **The restart races the reply.** Without the detached delay the turn dies; the
  user sees nothing and the service comes back healthy, which reads as a harness bug.
- **`Restart=on-failure` is not a substitute.** It covers crashes, not a clean restart,
  and it will not reload a changed unit or profile.
- **The public URL is upstream.** `--public-url` and `--trusted-host` come from
  `tailscale serve`; restarting DSH does not change the address, and serving a second
  instance on another port does not update this GUI.
- **A second `start` is not a restart.** Port 3080 belongs to the unit; starting
  another process fights it. Use `restart`.
- **Loading is not adoption.** A restarted process serves Sessions created or resumed
  after boot; a Session that was already live keeps its old composition until it is
  resumed again.
