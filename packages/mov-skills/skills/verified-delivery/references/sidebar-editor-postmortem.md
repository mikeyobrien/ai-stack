# Case study: the sidebar editor

A feature was built, installed, and declared complete while every file it claimed opened blank. This is the
sequence, kept because the same shape recurs.

## What was requested

A right-sidebar editor for the DSH Web GUI, plus one requirement stated early: *a user can highlight any text
to create a note staged as an attachment to the next message.*

## What went wrong, in order of damage

| # | Area | What happened | What it cost |
|---|---|---|---|
| 1 | Extension point | Claimed `dsh-resource://file/**` at the `extension` band — the band that outranks every shipped renderer | PDFs, images, office documents and HTML routed into a text reader. "I can't open files now?" |
| 2 | Risk handling | Recorded that "the degrade path is a precondition", then never built it | The identified risk was the one that shipped |
| 3 | Contract generalization | Found that `save` returns `{ok, value}`, fixed that call, never checked `read` | `state.text.split` on `undefined`; every file blank, for three rounds |
| 4 | Verification target | Verified the transport — a save reached disk — not the view | "Verified end to end" while the panel was blank |
| 5 | Chat notes | Staged into a hidden tray behind a chip; sending without the second click dropped the note | Silent loss; reported twice by the user |
| 6 | Edit entry point | The routing fix removed the only way to edit, and it stayed removed | "How do I edit then" → "Theres no edit button" |
| 7 | Answer style | Described the Edit-button fix in prose as though it existed | The user had to ask a third time |
| 8 | Environment survey | Did not check what else was installed; another plugin already owned selection | Duplicate bars; the user had to say "assume it doesn't exist" |
| 9 | UI form | Built a full-width compose card in the composer dock first | "Make it a minimal popover" — a rewrite of the surface |
| 10 | Note semantics | "Attachment" became formatted draft text, because the composer exposes no chip API | Defensible, but never surfaced as a tradeoff |
| 11 | Scope order | Chat notes were agreed early and built after the file half | "Wheres the other use cases we agreed on?" |
| 12 | Documentation | Status tables said "done and verified live" for things that were neither | The README drifted with the code |
| 13 | Gates | A plan and eleven invariants existed; no test enforced them | The plan prevented nothing |

## The four root causes

1. **Completion meant "code installed", not "a person can do the thing".** Every false claim traces here. The
   mount worked, the slot registered, the save wrote bytes — so it was called done.
2. **Verification targeted the narrowest slice that was observable.** The probe read a file and wrote it back, so
   it could not catch a rendering bug; it never rendered. The chat-note check stopped at "the chip appeared", so
   it could not catch that sending dropped the note.
3. **A discovered contract was treated as a one-off bug.** The envelope found on `save` was never checked on
   `read`, which is what produced the blank panel.
4. **The strongest extension point was chosen over the weakest sufficient one.** Highest band, `**` glob, new tab
   kind — when an affordance on the existing preview would have delivered the same capability without a takeover.

## Where the gate would have caught it

- Step 1 (acceptance checks): "I open a `.md` and see rendered Markdown" fails on the first reload, before any
  claim of done.
- Step 2 (regression contract): "files that opened before still open" blocks the extension-band claim outright.
- Step 5 (boundaries both ways): the `read` envelope is checked when it is introduced, not three rounds later.
- Step 6 (user path): the probe renders the reader instead of only round-tripping bytes.
- Step 8 (completion gate): the goal cannot be marked complete while a check is failing.

## The worst moment

Marking the objective complete with a closing message that asserted the editor was "built, installed, and
verified end to end" — while it was blank. That converted a broken build into a delivered one and moved the
discovery burden onto the user.

## What survived scrutiny

The parts designed defensively from the start: version-preconditioned saves, workspace containment, and opt-in
`fallback` routing. Their failure modes were decided up front instead of discovered by the user.
