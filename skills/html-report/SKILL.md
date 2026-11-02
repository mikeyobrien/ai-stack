---
name: html-report
description: "Use when turning a Markdown report and its evidence into one HTML page a reviewer can read — screenshots, diagrams, and tables beside the prose, with an evidence shelf in the sidebar. Renders deterministically from a fixed template, so the same input always produces the same bytes."
---

# HTML Report

## Why

Agents write reports as Markdown and attach evidence as loose files. The reader
then opens a `.md`, reads a sentence that says "see `evidence/screenshots/03-error.png`",
and goes hunting through a folder to find the picture that makes the claim
checkable. The evidence exists and is unreachable at the moment it matters.

Hand-authoring HTML per report fixes the page and breaks everything else: no two
reports look alike, each one is a fresh design decision, and the layout is
re-decided every time the facts are re-checked. The trade is backwards — prose
is what changes, the page should not.

Existing renderers solve determinism and leave the evidence out. Pandoc, Quarto,
and mdBook produce a page from Markdown, but their sidebars are built from
headings alone, so a screenshot is only ever a link in a paragraph. Report
skills that do embed screenshots carry one team's layout, re-authored per run.

The gap is a renderer the skill owns: a fixed template, a documented input
format, diagrams resolved at build time, and a sidebar with a shelf for the
evidence. The writing agent supplies prose and references; it never supplies
HTML.

## What

A workflow plus one zero-dependency script that turns a Markdown report and its
evidence into one page:

- a **fixed template**: one shell, one stylesheet, dark and light, print rules;
- a **sidebar** with the document outline and an **evidence shelf** — every
  figure as a thumbnail, grouped by the folder it came from, linked to its
  place in the report;
- **figures**: images promoted to numbered captioned figures, click to enlarge;
- **diagrams**: `mermaid` fences pre-rendered to SVG at build time, plus any
  pre-rendered image, so the page ships no diagram JavaScript;
- **one portable file by default** — every asset inlined, so it renders from
  any path — plus a folder mode (`--folder`) for large evidence sets;
- **a `--detailed` layout** that turns the page into an argument: a hero stating
  the audience and the ask, a standfirst, numbered sections, metric cards, pull
  quotes, side-by-side evidence, status chips, and one of four visual registers
  chosen from the stated audience;
- **a loud build**: every unresolved reference is named with its line number
  and fails the exit code — a missing screenshot never renders as an empty box;
- **determinism**: the same input produces byte-identical output.

It covers reports: findings, audits, remediations, experiment write-ups,
post-mortems, status updates. It does not cover slide decks, PDFs, live
dashboards, or a corpus of cross-linked pages, and it does not edit the report's
content. It renders; it does not decide what to say.

## How

1. **Write the report in the format.** Frontmatter for title, date, status, and
   provenance; `##` and `###` for structure; tables for measurements and
   verdicts. Read `references/format.md` first — the subset is small, and a
   construct outside it is reported rather than silently approximated.
2. **Reference evidence as images, not as paths.** Any sentence that points at
   a screenshot uses `![what it shows](evidence/screenshots/03-error.png)`.
   Backticked paths and bare filenames do not reach the shelf. The alt text is
   the caption, so write it as what the reader should notice.
3. **Put the assets where they will group.** The shelf groups by the image's
   top folder: `evidence/…` is the default shelf, another folder gets its own
   heading, and diagrams get one too. Grouping is a property of the tree, not a
   directive to remember.
4. **Render.**
   ```bash
   node <skill>/scripts/render-report.mjs report.md
   ```
   The default is one self-contained file, because that is the form that
   survives being previewed, moved, or mailed. Add `--folder` when the evidence
   set is large enough that inlining is wasteful, and `--out` to place the page
   somewhere else.
5. **Read the build output.** Every `problem:` line is unresolved input — a
   missing image, a diagram that does not parse, a remote image that breaks
   offline reading. Fix them; do not hand-edit the HTML.
6. **Prove determinism when it matters.** Build twice into different
   destinations and compare. Identical output means the report is a function of
   its input, which is what makes a diff of two reports meaningful.
7. **Look at the page.** Open the HTML, or screenshot it, and check three
   things: the shelf lists every figure, every figure renders at a readable
   size, and the diagram is legible. A page that builds is not a page that
   reads.
8. **Hand over the path**, not a description of the path. Say which mode was
   built and whether any reference is still unresolved.

9. **Decide whether it is a document or an argument.** A reference page — what
   happened, what was measured — reads fine as a document. A page that asks for
   a decision is an argument, and `--detailed` is for that: name the `audience`,
   state the `decision`, write the `lede`, and let the report open with the ask
   instead of a title.

Options: `--detailed`, `--folder`, `--out <path>`, `--single`, `--title <text>`,
`--no-mermaid`, `--quiet`. Environment overrides: `HTML_REPORT_CHROMIUM`,
`HTML_REPORT_MERMAID`.

## Gotchas

- **Evidence as a path.** A report that says "`evidence/03-error.png`" renders a
  code span and an empty shelf. The single most common way this skill is
  defeated is a report that lists its assets instead of showing them.
- **A silent gap.** An image that does not resolve must fail the build. Check
  the exit code, not just the presence of an HTML file — a page is still written
  on failure so there is something to look at.
- **Hand-editing the output.** The page is generated. A fix that lives in the
  HTML is gone on the next build; fix the Markdown.
- **Restating the report.** Two titles, a subtitle that repeats the title, and a
  summary paragraph that repeats the intro all come from writing the page
  instead of the prose. The template has one place for each thing.
- **A diagram that cannot render.** Build-time Mermaid needs a headless browser
  and a vendored build. When either is missing the build says so; do not fall
  back to an unstyled code block and call the diagram done.
- **A shelf that flatters.** The shelf is not decoration: if a figure is in the
  report it is in the shelf, and if it is in the shelf it is worth looking at.
  Do not add decor or drop evidence to make the rail look balanced.
- **Byte drift.** Output is deterministic only for the same assets. Pointing at
  a screenshot that is regenerated every run changes the page — the hash in the
  asset name is telling you the input changed.
- **Dialect creep.** Raw HTML, footnotes, definition lists, and reference-style
  links are outside the subset. Reach for a callout, a table, or a paragraph.
- **Decoration mistaken for tailoring.** `--detailed` is not "add cards". It is
  the same content told to a named reader: the register follows the audience,
  the hero states the ask, the metrics carry the argument. If the audience and
  the decision cannot be named, the page is a document and the plain layout is
  the honest one.
- **A register that fights the content.** A dense audit in `editorial` wastes
  the reader's time; a funding ask in `instrument` reads as a log file. Pick the
  voice the reader already trusts.
