# pi extensions

User-authored pi extensions go here as `*.ts` files. `install.sh pi` symlinks
each one into `~/.pi/agent/extensions/`.

Deliberately not vendored:

- `herdr-agent-state.ts` — installed and owned by herdr; its header says
  reinstalling or updating the integration overwrites it. Let herdr manage it.
- `auth.json`, `trust.json`, sessions, and caches — machine-local credentials
  and state, not setup.

pi extensions can also be npm packages; those are declared in
[`../npm/package.json`](../npm/package.json) and in `settings.json`'s
`packages` list.
