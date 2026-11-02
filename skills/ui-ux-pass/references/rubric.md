# UI/UX pass rubric

The stable part of the pass: state coverage, named checks, severity anchors, the walkthrough worksheet, and the report shape. The screenshots and the user frame change per product; these do not.

## How to use this rubric

- One finding names one check. If two checks apply, pick the one closest to the user consequence and mention the other in the remedy.
- Evidence is re-openable: a screenshot path plus a selector or URL plus the visible text. If the screenshot does not show it, the finding is not ready.
- Text from a hidden element is not visible state. Assert visibility before reading text, or use the screenshot; a hidden node can still return its innerText.
- Separate **fact** (what the render shows) from **inference** (what a user would likely think or do). Inference is allowed; presenting it as fact is not.
- Confidence: **high** = observed and reproduced on a second run; **medium** = observed once; **low** = inferred from a partial state. A low-confidence finding can still be reported, but it is labeled.
- A check that passes is not a finding. Mention it under "what works" only if it is worth protecting.

## Observer modes

- **Pixel**: the observer can read the screenshots. Every cited screenshot must have been opened; pixel judgments are allowed.
- **Delegated pixel**: the main observer cannot read images, so an image-capable observer reads the screenshots and returns descriptions. Cite those descriptions as the pixel evidence and name the observer.
- **Measured**: no observer can read images. Evidence comes from `inspect` (computed styles, attributes, boxes), `text`, and the accessibility tree. The screenshot is an artifact for a human, not a claim the agent verified. Do not write "looks cluttered", "feels heavy", or any judgment that requires seeing the image; say the visual quality is not assessable.

Declare the mode in the report before the findings. A measured pass is not a failed pass, but it cannot claim pixel-level craft.

## Severity anchors

Use Nielsen's 0–4 scale, anchored to the task goal, not to visual taste.

| Score | Label | Meaning for this pass |
|---|---|---|
| 4 | Critical | Blocks the task, causes data loss, or creates a real safety or trust failure. Fix before release. |
| 3 | Major | Significant friction; many users would struggle or abandon. Fix next. |
| 2 | Minor | Noticeable; users recover with effort. Queue it. |
| 1 | Cosmetic | Polish; fix when convenient. |
| 0 | Not a problem | The check passes; do not report it as a finding. |
| ✓ | Positive | Works well; keep and replicate. |

Calibrate with three questions: does it block the goal, how many users hit it, and how often? A single rater's severity is unreliable; state confidence and do not present the number as consensus. When in doubt between two scores, take the lower one and explain the uncertainty.

## State matrix

Capture what the product actually ships. A state that cannot be reached is recorded as skipped with the reason; it is never guessed.

| State | How to reach | Captured? | Notes |
|---|---|---|---|
| Default / happy path | Open the target screen with realistic data | | |
| Empty | New account, cleared list, first run | | |
| Loading | Throttle or delay the data request; capture before it resolves | | |
| Error | Abort the data request or submit invalid input | | |
| Success | Complete the primary action | | |
| Disabled / partial | Missing permission, incomplete form, read-only mode | | |
| Long content | Long title, long list, large number, wrapped text | | |
| Narrow viewport | 360–400 px wide | | |
| Dark / light | Emulate both color schemes if both ship | | |
| Zoom / reflow | 200% zoom or 320 px reflow | | |

A transient state is captured while it is true. If a screenshot taken after a loading or error state ended shows the default, the shot is wrong; recapture it or cite the replay and say the first capture missed. Silence must not imply a state passed.

The minimum for a normal pass is default, empty, loading, error, and one narrow viewport. If the product has no empty or error state, that absence is itself a finding.

## Named checks

Use the ID in every finding so two runs are comparable. Severity is the default; adjust with the anchors and say why.

### Hierarchy and action

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| HIER-01 | One dominant action | The most prominent control is the primary next step, and there is exactly one | Screenshot; computed size/weight/position of controls | 3 |
| HIER-02 | Competing primaries | Two or more controls look equally primary, or a destructive action looks primary | Screenshot; control labels and styles | 3 |
| HIER-03 | Grouping and proximity | Related controls sit together; unrelated controls are separated | Screenshot; DOM order | 2 |
| HIER-04 | Progressive disclosure | Secondary or advanced options do not crowd the first decision | Screenshot; visible control count | 2 |

### Layout and legibility

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| LAY-01 | Spacing rhythm | Consistent spacing scale; no accidental gaps or collisions | Screenshot; bounding boxes | 1 |
| LAY-02 | Alignment | Labels, fields, and actions share edges or a clear grid | Screenshot | 1 |
| LAY-03 | Overflow and truncation | Long text wraps, clips, or pushes layout; nothing is cut without a way to read it | Screenshot at long content and narrow width; scrollWidth vs clientWidth | 3 |
| LAY-04 | Density | The screen is scannable; text and controls are not packed past reading comfort | Screenshot; line length and control count | 2 |
| LEG-01 | Contrast | Text and essential icons are distinguishable from their background | Screenshot; sampled colors if needed | 3 |
| LEG-02 | Small text | Secondary text is still readable at the shipped size | Screenshot; computed font size | 2 |
| LEG-03 | Icon-only controls | Every icon-only control has a visible or accessible name | Screenshot; accessible name | 3 |

### States and feedback

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| STA-01 | Empty state | The empty state explains what this is and offers the action that fills it | Screenshot; visible copy and controls | 3 |
| STA-02 | Loading state | Loading preserves layout and says what is happening; no bare flash or dead screen | Screenshot during delayed request | 2 |
| STA-03 | Error state | The error says what failed, whether data is safe, and what to do next | Screenshot with the request aborted | 3 |
| STA-04 | Disabled and partial | Disabled controls say why; partial data is labeled | Screenshot | 2 |
| STA-05 | Success feedback | A completed action produces visible confirmation that survives long enough to read | Screenshot; notice persistence | 2 |
| FBK-01 | Latency and progress | Slow work shows progress, not an unchanging screen | Screenshot during delay | 2 |
| FBK-02 | Notice persistence | Notices do not vanish before they can be read, and do not stack into noise | Screenshot; timing | 2 |
| FBK-03 | Destructive confirmation | Destructive or irreversible actions are distinguishable and confirmable | Screenshot; control behavior | 4 |

### Navigation and flow

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| NAV-01 | Selection visibility | The active item, tab, or filter is visibly selected | Screenshot | 2 |
| NAV-02 | First click | The first control a new user would choose matches the intended path | Screenshot; task prediction | 3 |
| NAV-03 | Escape and back | Every opened surface has an obvious way out that does not discard work | Screenshot; control inventory | 3 |
| NAV-04 | Deep link and refresh | The state survives a refresh or can be reopened from a URL | URL after refresh; screenshot | 2 |

### Forms and input

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| FRM-01 | Labels | Fields have persistent labels, not placeholder-only labels | Screenshot; label association | 3 |
| FRM-02 | Validation | Errors appear next to the field, say how to fix it, and keep the input | Screenshot; invalid submit | 3 |
| FRM-03 | Input preservation | A failed save or submit does not erase what the user typed | Screenshot; retry after failure | 4 |

### Responsive and input modes

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| RSP-01 | Narrow collapse | At 360–400 px, controls wrap or collapse without overlap or lost actions | Screenshot at narrow width | 3 |
| RSP-02 | Touch targets | Interactive controls are large enough to hit without precision | Screenshot; measured size | 2 |
| RSP-03 | Zoom and reflow | At 200% zoom or 320 px, content reflows instead of clipping | Screenshot at zoom | 2 |

### Consistency and content

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| CON-01 | Terminology | The same concept has one name across screens | Screenshot set; visible labels | 2 |
| CON-02 | Component behavior | Similar controls behave the same way in similar places | Screenshot set; observed behavior | 2 |
| CON-03 | Formats | Dates, numbers, and units are consistent and unambiguous | Screenshot | 1 |
| CNT-01 | Plain language | Labels and messages use the user's words, not internal or technical terms | Screenshot; visible copy | 2 |
| CNT-02 | Helper-text dependence | The screen still makes sense if helper text is ignored | Screenshot; visible copy | 2 |
| CNT-03 | Actionable error copy | Error text names the cause and the next step, not just "failed" | Screenshot | 3 |

### Visible accessibility

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| A11Y-01 | Focus visible | Keyboard focus is visibly indicated on every interactive control | Screenshot with focus; tab sequence | 3 |
| A11Y-02 | Keyboard reachable | Every action can be reached without a pointer | Tab sequence; screenshot | 3 |
| A11Y-03 | Name and semantics | Controls expose a name and role; headings and lists are marked up | Accessibility tree snapshot | 2 |

A11Y-01 and A11Y-02 can be checked visually and with the keyboard. A11Y-03 needs the accessibility tree; if that was not captured, put it under "not assessable", not "pass".

### Motion

| ID | Check | Look for | Evidence | Default |
|---|---|---|---|---|
| MOT-01 | Reduced motion | Motion respects `prefers-reduced-motion` or is not essential to understanding | Screenshot set; media emulation | 2 |
| MOT-02 | Purposeful animation | Animation explains a change rather than decorating it | Screen recording or before/after stills | 1 |

## Cognitive walkthrough worksheet

Write this before opening the UI, then fill it in during the walk.

```
Task: <what the user is trying to do>
Start: <screen and state>
Goal: <observable success>
Expected first action: <control the user should pick first>

Step 1 — <screen/state>
  Sees: <the visible options, in the user's words>
  Will they try the right effect? <yes/no/unsure — why>
  Will they notice the action? <yes/no/unsure — why>
  Will they connect it to the goal? <yes/no/unsure — why>
  Will they see progress? <yes/no/unsure — why>
  Think-aloud: <what a screen-only user would say here>
  First click: <what they actually picked>
  Friction: <where they hesitated, guessed, or stopped>
  Check: <ID or none>
```

The four questions are the cognitive-walkthrough core: try the effect, notice the action, associate it with the goal, see progress. Source: Digital.gov's cognitive-walkthrough guide and Wharton et al.'s formulation. Use them at every step; a step that passes all four is a positive, not a finding.

Do not lead the walk. If the task cannot proceed without implementation knowledge, that is a finding (NAV-02 or STA-03), not a reason to use the knowledge.

## Report template

```markdown
# UI/UX pass — <surface> — <date>

**Scope.** <journey, tasks, screens, viewports>
**Environment.** <URL, browser, build/commit, data>
**Observer mode.** <pixel / delegated pixel / measured; who read the images; contaminated or not>
**Verdict.** <one line per task: completed / struggled / blocked>

## Coverage
| State | Captured | Evidence |
|---|---|---|
| default | yes | screenshots/01-default.png |
| empty | yes | screenshots/04-empty.png |
| loading | skipped — too fast to capture | — |
...

## Findings
### F1 — <action title> — SEV <0–4>, confidence <high/medium/low>
**Check:** <ID>
**Where:** `screenshots/03.png`; `<selector or URL>`
**Observed:** <visible fact>
**Inference:** <what a user would likely think or do>
**Consequence:** <what it costs the task>
**Remedy:** <smallest change that fixes it>
**Effort:** S / M / L

## Top three fixes
1. ...
2. ...
3. ...

## What works
- ...

## Not assessable
- <quality> — <why it could not be observed>

## Evidence index
- `screenshots/01-default.png` — default screen
...
```

## Anti-padding rules

- Three to seven findings is a complete pass. More than seven means the scope was too wide; narrow the journey.
- No finding without a re-openable screenshot and a selector or URL.
- A passing check is not a finding, and a preference is not a defect. If the only support is taste, drop it.
- Include at least one positive that is worth keeping; a report with no positives reads as advocacy.
- If the same issue appears on several screens, report it once and list the screens.
- If a state was skipped, say so in coverage; do not let silence imply it passed.
