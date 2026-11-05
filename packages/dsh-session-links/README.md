# dsh-session-links

Shareable links to chat threads. The Client half opens the session a page URL
names; the Host half answers `session_link`, so an agent can hand you the link
for this conversation or one it names.

## Link forms

| Form | Where it works |
| --- | --- |
| `https://<host>/?session=<id>` | anywhere — the canonical shareable URL |
| `https://<host>/#dsh-session:<id>` | anywhere; the fragment keeps the reference shape |
| `dsh-session:<id>` | as a reference in notes and messages; clicking it needs an OS/PWA scheme handler |

The Client reads all three when the page loads, selects the session, and clears
the marker so a refresh does not re-open it. A link to a session that is not in
the current workspace still opens, because selection goes through the Session
Controller rather than the sidebar list.

## Tool

`session_link` returns `{ sessionId, url, reference }`:

```json
{
  "sessionId": "session-…",
  "url": "https://columba.example/?session=session-…",
  "reference": "dsh-session:session-…"
}
```

Call it with no argument for the current session, or `sessionId` for another
thread.

## Notes

- The GUI has no per-session route of its own; this bundle adds the handling in
  the browser, so a link only opens when the bundle is installed in the profile.
- The notifier's pushes use the same `?session=<id>` form, so a tap lands on the
  thread that finished.
- A bare `dsh-session:` reference is a shareable identifier, not a clickable
  link, until an OS handler or a PWA protocol handler is registered for the
  scheme.

## Install

Install the bundle from this checkout (`dsh plugin --profile <name> add
./packages/dsh-session-links`). Its `cordis.patch.yml` inserts the
`session-links` row.
