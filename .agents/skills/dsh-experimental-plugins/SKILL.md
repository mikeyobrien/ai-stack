---
name: dsh-experimental-plugins
description: "Use when enabling, disabling, or debugging a DSH experimental capability — a Plugins-page bundle versus an explicit composition installed as a plain dependency — including the version pinning, profile patch rows, and platform gates that decide whether it can work at all."
---

# DSH Experimental Plugins

## Why

DSH ships experimental capability in two shapes, and the Plugins page only shows
one of them. So the same three questions arrive over and over: the switch is
missing (is it a version fact or an error?), the install "succeeded" but nothing
happens (it was a plain dependency, not a bundle), and the version someone pinned
was the wrong one (`latest` on these packages is frequently a stale early alpha).

Each has a checkable answer, and none of the checks are obvious from the UI.

## What

A procedure for turning an experimental capability on, proving it composed, and
turning it off again:

- deciding toggle versus explicit composition from the release's own catalog;
- installing packages pinned to the running version;
- writing the profile rows that a non-bundle package needs;
- verifying composition without booting the app;
- the traps that produce a silent no-op.

It does not cover authoring a bundle (`packages/<name>/` with `dsh.bundle.patch`)
or writing the capability itself. For what this profile has enabled and why, see
`<repo>/docs/experimental-capabilities.md`.

## How

1. **Know the running version.** `dsh --version` prints the exact publish line,
   e.g. `0.2.1-rc.5`. Every package installed for this profile must match it.
2. **Find the catalog for that version, not for master.** Optional bundles are
   listed in one place per release: `dsh-app-boot` through 0.2.1, and
   `@deepseek-ai/dsh-official-bundles` from 0.2.2. Grep the installed package's
   `lib/index.js` for `OPTIONAL_BUNDLES`. A package absent from that list has no
   switch in this version — no amount of configuration will produce one.
3. **Treat platform gates as part of the catalog.** Some entries are hidden or
   refused off-platform rather than missing. Read the bundle's `cordis.patch.yml`
   for a `disabled: !!js process.platform !== …` row before promising a switch.
   Computer Use is macOS-only and refuses enablement elsewhere.
4. **Toggle bundles from Plugins.** The **Experimental plugins** section lists the
   primary ones; **More** beside its heading lists every offered bundle. A switch
   adds or removes the package in the active profile's `dsh.profile.bundles`. It
   is per-profile, and it does not touch this repo's portable profile — mirror the
   name into `dsh/profile/package.json` when it should survive a reinstall.
5. **Compose what has no bundle.** Install pinned, then add rows:
   `dsh plugin --profile <p> add "<pkg>@$(dsh --version)"`. The command prints
   `declares no dsh.bundle — installed as a plain dependency, not a profile layer`;
   that warning is the whole point, not noise.
6. **Write rows in dependency order.** A service row before its provider row, both
   under `- insert:` in the profile's `cordis.patch.yml`. Provider configuration
   goes on the provider row. Rebuild the profile with `./install.sh dsh` when it
   is the portable one.
7. **Verify by composition dump, not by install output.**
   `dsh --profile <p> --dump-config | grep -A2 <row id>` must show the rows in the
   order you expect. An install proves the package is on disk; only this proves it
   is in the tree.
8. **Expect the runtime to lag the composition.** A newly mounted provider usually
   serves Sessions created or resumed after it loads, not the one that is already
   running. New session first, restart second, and say which one you verified.
9. **Revert in the same order.** Remove the rows, then
   `dsh plugin --profile <p> remove <packages>`. Removing the row first keeps the
   tree valid at every step.

### Questions

- Is the switch missing because this release never shipped it, or because the
  platform refuses it? Both look like "not there".
- Does the capability hold per-Session state? If yes, a generic bridge is not an
  equivalent substitute — per-Session browser ownership is not the same thing as
  one shared MCP server.
- Is the pin the running version, or whatever npm calls latest?

### Gotchas

- **`latest` lies on release-line packages.** Several are published with a stale
  `latest` and the good build under `next`. Always pin `@<dsh --version>`.
- **A plain-dependency install changes nothing by itself.** No rows, no tools; the
  capability is inert and looks broken.
- **`dsh plugin add` edits the live profile only.** The repo copy drifts unless you
  also edit `dsh/profile/package.json` or `cordis.patch.yml`.
- **Prompt ordering can break.** Tools from a composition that needs a connection
  must stay under `<unlisted-tools>` in an explicit `toolOrder`; naming them fails
  prompt assembly for Sessions without that connection.
- **A toggle is not an uninstall.** Turning a bundle off keeps its files; removing
  the package is a separate action.
- **Project skills are not part of this.** `<repo>/.agents/skills/<name>/SKILL.md`
  is discovered by `dsh-skill-filesystem` at the top level only; one level of
  nesting is a `mov-skills` feature, not a filesystem one.
