# Vendored Mermaid

`mermaid.min.js` is the single-file UMD build of Mermaid, copied from the
package tarball and served from disk. Nothing here loads from a network at
build time or at read time.

- **Version:** 11.17.2
- **Upstream:** <https://www.npmjs.com/package/mermaid>
- **License:** MIT, © the Mermaid contributors
- **Size:** 3.5 MB, committed on purpose so a report build never needs a network

## Why it is vendored and not bundled

Mermaid's own ESM entry is small, but every diagram type is a dynamic chunk. A
single bundled file that covers all types measures 7.2 MB raw / 1.39 MB gzip
([measured upstream](https://github.com/wingsky-1/dsh-plugin-hub/issues/104)).
The renderer therefore does not ship Mermaid inside a report. It loads this
file **at build time only**, in a headless browser, to turn a `mermaid` fence
into an SVG. The report page contains the SVG and no Mermaid code at all.

## Refreshing

```bash
curl -O https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js
mv mermaid.min.js packages/mov-skills/skills/html-report/vendor/
```

Re-render a report with a diagram afterwards: the SVG is part of the output, so
a version bump changes the page and the asset hash — which is the intended
signal that the input changed.

Point `HTML_REPORT_MERMAID` at another build to try one without touching the
vendored copy.
