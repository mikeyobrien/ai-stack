# Artifact Library

A Library panel for the DSH Web UI: find and read research, designs,
reports and their HTML editions across projects, with pinned items,
local search, revisions and origin links.

The Library is a curated registry of deliverables this user produced, not a
generic file browser. Every artifact is registered against a path that lives
under an approved root; the panel never serves a file the registry did not
register.

## How it works

- **One durable registry per profile** — a small JSON document under the
  DSH home (`~/.dsh/artifact-library/registry-<profile>.json` by default).
  It records collections (topics), artifacts (readable files), expected
  outputs, a pinned flag and a bounded snapshot of each artifact's text.
- **Snapshots are a deliverable, not a copy of a tree** — when an original
  file is deleted, its snapshot (at most 512 KiB of text, 2 MiB for HTML)
  keeps the Library readable.
- **Reads are safe** — every read re-resolves the candidate path and every
  approved root through the filesystem (`realpathSync`), re-checks the
  resolved path against the resolved roots, and refuses any read above
  `MAX_READ_BYTES` (4 MiB) before the file is opened. A symlink that points
  outside an approved root is not read.
- **The HTML reader is sandboxed** — an artifact's HTML is rendered in an
  `<iframe sandbox="…">` with a restrictive CSP (`default-src 'none'`,
  no `allow-modals`). The host page's React tree never receives the HTML as
  an `innerHTML` node.
- **Markdown is rendered locally** with a small dependency-free converter
  (headings, lists, code, tables, links). Raw embedded HTML in a markdown
  body is dropped rather than executed.
- **The Library is the only remote entry point** — the `artifactLibrary`
  namespace exposes `library`, `search`, `artifact`, `setPinned`, `register`
  only. There is no path-to-URL route and no raw file endpoint.

## Files

| file | role |
|---|---|
| `package.json` | bundle manifest; `dsh.bundle.patch` points at the composition row |
| `cordis.patch.yml` | one insertion row for the Web composition |
| `index.js` | Host: the `artifactLibrary` remote service, the store and `seedRegistry` |
| `store.js` | the durable registry, the bounded reader, the root resolution |
| `security.js` | path normalisation, `realPath`, root containment, the sandbox/CSP constants |
| `render.js` | the dependency-free markdown→HTML converter and the document wrapper |
| `client.js` | Web client: the Library panel (list page, reader page, pin, search, project filter) |
| `locale/en.json` | the panel's English strings |
| `icon.svg` | the Library sidebar icon |
| `test/*.test.js` | behavior tests (store, security, render) |

## Testing

```bash
node --test test/*.test.js
```

Covers: seed import (snapshots real files, no duplicate ids), a deleted
original (the saved copy stays readable), search (title, project, and
body-only hits), registration (idempotent by id, revision history, path
update, out-of-root rejection), symlink escapes (file and directory link
pointing outside an approved root are refused), the byte cap, and the
markdown/HTML renderer (no `javascript:` links, no raw `<script>`/`onerror`
in the rendered output, the sandbox attributes).
