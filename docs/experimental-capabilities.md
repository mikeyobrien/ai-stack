# Experimental capabilities

DSH ships experimental capability in two shapes. They are not interchangeable, and
the Plugins page only shows the first.

| Shape | Where it appears | How to turn it on |
| --- | --- | --- |
| Optional bundle | Plugins page, with a switch | GUI toggle, or the bundle name in `dsh.profile.bundles` |
| Explicit composition | nowhere | install the packages, add rows to `cordis.patch.yml` |

## Optional bundles

Default-off bundles the installation already carries: switching one on downloads
nothing. In Web, open **Plugins**; the **Experimental plugins** section lists the
primary ones, and **More** beside its heading lists every offered bundle. A switch
adds or removes the package in the running profile's `dsh.profile.bundles`; the
dependency stays installed when it is off.

Profiles with HMR recompose before the toggle returns. Profiles without it need a
restart. Disabling a bundle unregisters its rows; for Git Worktrees that leaves
existing checkouts and branches untouched.

The set is bound to the DSH version. `0.2.1-rc.5` keeps it in `dsh-app-boot`;
`0.2.2-alpha.2` moved it to `@deepseek-ai/dsh-official-bundles`. When a switch you
expect is missing, read that list for the running version before looking for a
configuration fault — the capability may simply not exist in that release.

| Plugins page | Package | Adds |
| --- | --- | --- |
| Git Worktrees | `dsh-experimental-tool-worktree` | `create_worktree` |
| Agent Teams | `dsh-experimental-agent-team-profile` | roster, task board, team tools |
| Persistent terminals | `dsh-experimental-terminal-bundle` | shells that outlive a tool call |
| Session search | `dsh-experimental-session-search` | search earlier sessions |
| Ralph loops | `dsh-experimental-ralph-bundle` | repeated work with fresh agents |
| Auto Authorization Review | `dsh-experimental-auto-review` | model-judged permission mode |
| Developer Tools | `dsh-experimental-inspector-profile` | session and backend inspection |
| Custom plugin markets | `dsh-experimental-plugin-market-bundle` | Discover tab for market indexes |
| Voice input | `dsh-experimental-voice-input-bundle` | SenseVoice transcription |
| Machine translation of reasoning | `dsh-experimental-cot-translation-bundle` | translated reasoning |
| Conversation-following titles | `dsh-experimental-session-titles-bundle` | titles refresh per prompt |
| DSH badge skill | `dsh-experimental-badge-skill-bundle` | "powered by dsh" badge |

The same names belong in `dsh/profile/package.json` when a profile should carry
one from a fresh install.

## Explicit compositions

Some experimental capability has no bundle, deliberately: it adds a large runtime
or needs an external program, so it stays a composition the profile opts into.
`dsh plugin add` installs it as a plain dependency and warns that it declares no
`dsh.bundle`; the rows below are what make it run.

### Browser automation

Per-Session Chromium through Playwright MCP: one browser per live Session, with a
queue, `mode: attach` to drive an existing browser, and per-agent activation.

Every package is published per release line. On npm, `latest` is a stale
`0.1.6-alpha.1`; the builds that match a release are under `next`. Always pin.

```sh
V=$(dsh --version)
dsh plugin --profile web add \
  "@deepseek-ai/dsh-browser-use@$V" \
  "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@$V"
```

Then add the rows to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: browser-use
      name: "@deepseek-ai/dsh-browser-use"
    - id: browser-use-playwright
      name: "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp"
      config:
        mode: launch        # or: attach
        headless: true      # false to watch the window
        # executablePath: /usr/bin/chromium
        # endpoint: http://127.0.0.1:9222   # mode: attach only
```

`@deepseek-ai/dsh-experimental-browser-use-runtime` arrives as a dependency and
needs no row. Chromium comes from the Playwright cache (`~/.cache/ms-playwright`);
`npx playwright install chromium` fills it when missing.

The provider mounts for Sessions created or resumed after the composition loads.
Loading or reloading it does not adopt already-active Sessions, so a restart of the
GUI is the reliable way to make it visible.

Two things to know when it is running: the browser child process starts from the
Session's working directory, and browser tools must stay under `<unlisted-tools>`
in any explicit system-prompt `toolOrder` — naming them breaks prompt assembly for
Sessions that have no browser.

Verify composition without booting:

```sh
dsh --profile web --dump-config | grep -A2 browser-use
```

Revert:

```sh
dsh plugin --profile web remove \
  @deepseek-ai/dsh-experimental-browser-use-playwright-mcp \
  @deepseek-ai/dsh-browser-use
```

and drop the two rows.

### Computer Use

`@deepseek-ai/dsh-cua-bundle` is macOS only. Its provider row is disabled on every
other platform (`disabled: !!js process.platform !== 'darwin'`), and non-macOS
Hosts hide the bundle from plugin lists and refuse enablement. Windows support is
in development; there is no Linux path. Do not add it here.

## What this profile enables

| Capability | How | Since |
| --- | --- | --- |
| Git Worktrees | optional bundle in `dsh.profile.bundles` | 2026-11-02 |
| Browser automation | explicit composition, packages pinned to `0.2.1-rc.5` | 2026-11-02 |

Worktree behaviour — retention, pool location, what creation does not do — is
covered in the [prior-art report](../research/worktree-prior-art/report.md); the
short version is that leaving a worktree keeps the checkout and its branch, and
nothing is deleted on your behalf.
