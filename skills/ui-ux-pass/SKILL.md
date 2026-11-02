---
name: ui-ux-pass
description: "Use when reviewing a running UI for visual and UX quality — drives a real browser along representative user tasks, captures rendered states, and reports evidence-linked findings with severity, without changing code."
---

# UI/UX Pass

## Why

An interface can pass its tests and still fail its user. Code review and assertions confirm that a control fires; they cannot see that the primary action is buried, the empty state is a dead end, or a first-time user clicks the wrong control. Screenshot-only reviews catch layout but cannot see focus, loading, latency, or interaction. Browser tests reach those states but answer "does it work", not "is it learnable". This skill joins the two: drive the rendered product along representative tasks, capture each state as evidence, and judge it against named checks.

## What

A bounded, read-only pass over a running web UI that produces a short findings report:

- a screen-only user frame and three to five tasks, written before the UI is opened;
- a captured state matrix: default, empty, loading, error, long content, one narrow viewport, and dark/light where both ship;
- a cognitive walkthrough of each task, with first-click expectations and think-aloud notes;
- findings tied to named checks, severity 0–4, confidence, and evidence (screenshot + selector or URL + observed text);
- an observer mode: **pixel** when the observer can read the screenshots, **delegated pixel** when an image-capable observer reads them, or **measured** when only DOM, computed styles, boxes, and text are available;
- a coverage table and an explicit "not assessable" list;
- a short "what works" section, so the pass is not an advocacy document.

It covers web interfaces reachable by a browser. It deliberately leaves out code changes, automatic fixes, native desktop or mobile apps, performance benchmarking, accessibility certification, visual-regression baselines, and real user research. A pass that cannot reach a state says so; it does not guess.

**Generality.** Nothing here assumes a product, framework, or host. Selectors, routes, task names, and credentials are per-run adapters; the state matrix, named checks, severity anchors, walkthrough questions, and report shape are product-neutral. A marketing page, an internal admin tool, and a chat app get the same method. If the product has no sessions, lists, or APIs, those words do not appear in the plan.

## How

1. **Establish the contract.** Confirm the URL or launch command, environment, target user, the journey to review, three to five tasks, auth or seed data, and any action that must not be taken. Ask only for what blocks the pass. If no runnable UI exists, use supplied screenshots, mark the pass degraded, and never claim interaction you did not observe.
2. **Frame the user and write the tasks before opening the UI.** Describe a new or infrequent user who knows only what the screen shows. For each task, write the start state, the goal, the success signal, and the expected first action. These predictions are data: the walk tests them.
3. **Start an interactive browser session.** Use the session's browser tool if one exists; otherwise start the bundled helper in the background: `node <skill-dir>/scripts/ux-pass.mjs start --out <run-dir>`. Do not prewrite a step list. The state matrix in `references/rubric.md` is a coverage checklist, not a script; the next action depends on what the last one showed. Use disposable data and mark any destructive action `destructive: true`; the helper refuses those unless explicitly allowed.
4. **Drive one action at a time.** Send one command with `node <skill-dir>/scripts/ux-pass.mjs do --session <run-dir>/session.json '<json command>'`, read the returned observation, screenshot, console, and request failures, then choose the next action from what you saw. If a selector fails, inspect the visible controls with `text` or `inspect` and retry with a selector you can see. Reach each uncovered state this way: `open`, `click`, `fill`, `press`, `waitFor`, `assertText`, `assertVisible`, `assertHidden`, `inspect`, `screenshot`, `text`, `route`, `unroute`, `viewport`, `media`, `back`, `reload`, `url`. Use `route` with `abort` to force an error state and with `delayMs` to expose a loading state. The helper writes each action and observation to `manifest.json`; that transcript is the record, not a precondition. Stop the session with `close` when the walk is done.
5. **Inspect every render.** Decide the observer mode first. If the observer can read images, open each screenshot with the image-reading tool before citing it. If it cannot, delegate the pixel read to an image-capable observer that receives the screenshots and the task, or run in measured mode using `inspect`, `text`, and the accessibility tree. In measured mode, the screenshot is an artifact for a human reviewer, not a claim the agent visually verified; do not write findings that require pixel judgment (for example, "feels cluttered"). Check hierarchy and the dominant action, spacing and alignment, contrast and small text, truncation and overflow, empty/loading/error treatment, selection visibility, responsive collapse, and first-click affordance. Record the selector or URL and the visible text or computed value that supports each observation.
6. **Walk each task as a screen-only user.** At every step ask: will the user try to achieve the right effect; will they notice the action; will they connect it to the goal; will they see progress? Say the think-aloud note before clicking, record the first click, and stop when stuck instead of using implementation knowledge. If you have already read the code, hand this walk to a fresh-context observer (another agent with only the task, URL, and credentials) or label the walk contaminated. The walk is the part that makes this a UX pass rather than a screenshot audit.
7. **Judge with the rubric.** Map each observation to a named check from `references/rubric.md`. Assign severity 0–4 and confidence, and separate observed fact from inference. Include what already works. Aim for three to seven findings; more than seven means the pass is too broad. Every finding must carry evidence, the user consequence, a remedy, and an effort estimate (S/M/L).
8. **Report and verify.** Write `report.md` in `.agents/scratch/<YYYY-MM-DD>-ux-pass/` using the template in the rubric. Re-open or re-read every cited screenshot and confirm it shows the state the finding claims; a transient state that ended before the shot is a capture error, so recapture it or cite the replay and say so. Replay the successful path in a fresh browser with `node <skill-dir>/scripts/ux-pass.mjs replay --session <run-dir>/session.json`; failed attempts stay in the manifest but are skipped, because they are dead ends. Check that the top findings reproduce; if one does not, downgrade or remove it. Confirm no code or data was changed. Fixes are a separate request: do not edit the implementation inside the pass.

### Completion check

- Is there a user frame and task list written before the UI was opened?
- Is the observer mode declared, and does every finding stay within what that mode could observe?
- Was the session driven one action at a time, with an observation between actions, rather than from a prewritten step list?
- Does every finding cite a screenshot path, a selector or URL, and observed text?
- Were default, empty, loading, error, and one narrow viewport attempted, with skipped states named?
- Did each task get a screen-only walk with first-click and think-aloud notes?
- Are fact and inference separated, and is the "not assessable" list present?
- Is the report short enough to act on, with a top-three and a "what works" section?
- Did replay reproduce the top findings, and is the workspace unchanged?

### Gotchas

- **Image-blind claims**: citing a screenshot you cannot see. Delegate the pixel read or declare measured mode.
- **Transient mismatch**: a screenshot taken after a loading or error state ended shows the default. Verify the shot shows the state, or recapture.
- **Hidden text**: a hidden element can still return its text. `assertVisible` before `text` when the state matters; a text read alone does not prove the user can see it.
- **Scripted walk**: a prewritten step list turns the pass into a smoke test. Choose each action after observing the last result.
- **Tool coupling**: do not require one browser MCP or one product's DOM. Use whatever browser tool the session has; the helper is a fallback, and selectors are per-run adapters.
- **Code knowledge contamination**: finding the button because you wrote it. Delegate the walk or label the contamination.
- **Screenshot-only claims**: a still cannot show hover, focus, loading, motion, or latency. Capture the state or list it as unassessable.
- **Vibe findings**: "feels cluttered" with a heuristic name bolted on. Name the check, the visible symptom, and the consequence.
- **Padding**: a short report is valid. Do not invent findings to look thorough.
- **Happy-path only**: the default screen is the least interesting state. Force empty, loading, and error.
- **Destructive walk**: deleting real data or sending a real message to test a flow. Use disposable data and refuse irreversible actions.
- **False precision**: one rater's severity is weak. State confidence; do not present a score as consensus.
- **Code review in disguise**: wrong labels and missing handlers belong to code review. A UX finding is about what the render and the journey do to a user.
- **Accessibility overclaim**: a contrast check is not WCAG conformance. Name it as a visible check.
- **Reviewing the implementation**: if the report is mostly about code paths, the pass did not happen.
