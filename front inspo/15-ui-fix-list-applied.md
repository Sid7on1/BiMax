# 15 — The owner's UI fix list, applied

What landed from `14-ui-fix-list-2026-09-30.md`, item by item. Numbers are the list's own.

## Batch 1 — 5039189 (2026-09-30)

| # | What changed |
|---|---|
| 1 | The composer's placeholder never gets a scrollbar: an empty field never scrolls, typed text scrolls only past the cap, and the field refits when the column narrows. |
| 2, 3, 13 | Menus, the model catalogue and every dialog were ~77% opaque over live text. Floating surfaces are now the solid floating tint at 94%. |
| 4 | The + that opens the attach tray also closes it (it turns into a ×). The Done button is gone. |
| 5 | Hovering Settings shows five quick switches. App health moved out of the hover (still in Settings → Support). |
| 6 | Threads: five rows, then Show more. A row's everyday actions (Resume/Stop, Rename, Bin) appear on hover as icons; Priority, Link, Export, Archive and the rest are behind "…". |
| 7 | Recents names a session by what it is for: the Quick model's title after the first reply, the request without its greeting until then. The selected row lost its white strip. |
| 12 | The approval pill reads the engine's live gates instead of resetting to "Approve for me" on every remount, and "Custom rules…" unfolds instead of closing. Seven Settings toggles saved the config and never ran; the engine now applies them at boot and on save. Auto-commit commits only the files the edit wrote. |
| 13 | "Thinking budget" removed: `maxThinkingTokens` was saved and never sent. |
| 14 | The sidebar peek is readable over the conversation. |
| 15 | The peek survives the trip from the toggle to the panel (hover intent, no drag region while peeking). |
| 17 | Settings → Reduce motion quiets the app the way the system setting does. |

## Batch 2 — 7fa7278 (2026-09-30)

| # | What changed |
|---|---|
| 18 | Settings → Environment and ML Alchemist had cards drawn as buttons with nowhere to go ("Open Environment", "Open Alchemist"). They now list the inventory itself, read-only: each tool or backend with its version or "not found", in words as well as a dot. A card with no action no longer changes on hover or shows a pointer. |
| 19 | A real menu bar (`app/src/main/app.menu.ts`): Bimax, File, Edit, View, Window, Help. Every item runs the same command the keyboard does — the page keeps one handler per key and the menu shows the key without taking it. ⌘, (Settings) is the one key the menu owns. Edit carries the standard roles, so ⌘C/⌘V/⌘Z work in text fields. The ⌘2 bar is listed under File by its current shortcut and the menu is rebuilt when that shortcut changes. |
| 20 | The welcome headline is "Work you can verify." instead of "Great work starts here.", with one line saying what Bimax does: changes the project, runs its checks, shows what changed and whether it passed. |
| 21 | The ⌘2 hint line became a lesson: "Try it now: press ⌘2." Main tells the window when the bar opens (`threads:quick-shown`); the lesson then confirms once and never returns. "Not now" dismisses it for good. |

**Deliberately not built:** item 19 asked for a Trust Center menu entry. That was the Computer Use permission journey, and
the code-only product gate (`docs/product-reset/08_ACCEPTANCE_GATES.md`) forbids any frontend exposing it; a test fails
if a menu item names trust, computer, Mac control or permissions.

**Verification that ran:** app typecheck clean; app suite 114 suites / 992 tests pass; design-preview build passes;
13 deliberate breakages of the batch (a shown key that registers, a dropped Edit role, a dead ⌘2 item, developer tools in
a packaged build, a missing page command, no re-install on shortcut change, no `quick-shown` broadcast, the lesson's two
states, the static card's pointer, a dead link returned, the old headline) — every one failed a test.

**Not run:** `check:glass-contrast` cannot start on this Mac — it needs `puppeteer`, which left the project's
dependencies at 725b28c. The new lesson line uses `--raise-veil`, the same token as the starter cards beside it. Not yet
built, installed or clicked in the real app.

## Batch 3 — item 16, the menus' motion (2026-09-30)

**The review's premise was half right.** It read "bouncy: menus, 338 ms, 12.6%" off the source and said itself that it
needed live verification. Measured: `bouncy` never ran on a menu. It ran on the press-release of every sidebar pill and
row and on the Settings flyout (its `anim-pop-in` utility has no user). The real menus — model picker, approval pill,
Threads, sidebar and toolbar menus — are seeded morphs (`morph/tokens.ts`, `seedPopover`), and those barely overshoot
(under 1%). But they WERE slow, which is the part of the complaint that holds.

| | before | after |
|---|---|---|
| `bouncy` (pills and rows on release, Settings flyout) | 338 ms, 12.6% | 220 ms, 6.3% |
| model picker (340×420 from a composer chip), open | 379 ms | 242 ms |
| model picker, close | 304 ms | 208 ms |
| small menu (220×160), open / close | 308 / 263 ms | 196 / 163 ms |
| a menu flying across the window (680 px), open / close | 396 / 325 ms | 333 / 333 ms |
| panels and dialogs | 417 / 321 ms | unchanged |

Morph times are to within 1 px of the destination; overshoot is unchanged (ζ kept). What changed:

- `seedPopover` stiffness 520 → 1300, and menus close on their own `dismissPopover` (k 1800) instead of the shared
  `dismiss`, which would have folded a menu away slower than it opened. Panels keep `dismiss`.
- **A speed limit for menus**, 7000 px/s (117 px per 60 Hz frame). The faster spring moved a long menu flight 145 px in
  one frame, which the controller's no-teleport test forbids (a surface that jumps that far reads as two surfaces).
  The limit slows only a flight long enough to break it, and the open and the close of one menu share it, so an
  interrupted open still turns round smoothly.
- The one test that demanded `bouncy` overshoot MORE than 8% pinned the old number; it now holds the list's bound
  (≤8%, ≤240 ms). Said plainly because a test was changed.

**Not reached:** the list's "exit at ~75% of the entrance" (item 36). On a picker the speed limit stops the close at
208 ms, 86% of the open. A menu closed at 70% open turns round at once, as it did before this change (measured at the
old values too); closed at 10–30% it keeps its momentum for a frame.

**Verification that ran:** app typecheck clean; app suite 114 suites / 996 tests pass; motion-token drift check passes;
design-preview build passes; 11 deliberate breakages (old stiffness, old close, close ignoring the kind, every kind on
the fast close, no speed limit, limit per-spring or per-remaining-trip, a wrong peak-speed formula, a doubled limit, old
`bouncy`) — every one failed a test. **Not verified by feel on the real build**, which the list asks for: it is not
built or installed yet.

## Batch 4 — items 8 and 9, file tabs and find (2026-09-30)

The owner's answers: item 8 "tabs, but they are files"; item 9 "Cursor-styled".

**Item 8, file tabs.** The rejected strip of 2026-09-19 mixed four lane chips with file chips
(`13-right-panel-applied.md`). This one holds files only, and the lanes stay in the picker.

- In the Files lane, a row of tabs sits under the picker: a tree button first, then one tab per open file (icon,
  name, a folder hint only when two open files share a name, e.g. `index.ts api` / `index.ts web`). The active tab
  takes the raised fill; ✕ on the active tab and on hover; an unsaved tab shows a dot. Tabs keep their names and the
  row scrolls (a fade marks the edge with more). A first build let them shrink, and at 430pt five tabs read "AR…",
  "i… w"; that was seen in the preview and changed.
- Middle-click closes; right-click is a native Close / Close Others / Close to the Right / Close All / Insert @path /
  Reveal in Finder menu; ←/→ move between tabs; ⌃Tab / ⌃⇧Tab cycle; **⌘W closes the tab in front** (the window only
  when no tab is in front) and ⇧⌘W always closes the window. Closing lands on the tab to the right, as browsers do.
- **Closing an unsaved tab asks** on the native Save / Don't Save / Cancel sheet; before this, the ✕ of the old menu
  discarded edits with only a warning line. Cancel, or a save that fails, stops the rest of a Close All.
- The tree is one click away (the tree button, or the folder path above the file), and it **opens on the file you
  were in**: it used to come back folded to the root. The picker says "Files" while a file is open (the tab names the
  file); choosing Files from another lane returns to that file. The back/forward arrows are gone — the tabs are that.

**Item 9, find and replace.** CodeMirror's stock bar (full width, docked, browser-styled word buttons) is replaced by
a card floating at the top right of the editor, over the code, in the app's floating surface: the find field with
match case / whole word / regex toggles inside it (⌥⌘C / ⌥⌘W / ⌥⌘R), a live "3 of 12", previous / next, find in
selection, close; a chevron opens replace / replace all (↩ / ⌘↩). It jumps to the nearest match as you type, opens
pre-filled from the selection, and Esc hands the keyboard back to the code. The matching, highlighting and replace
commands are CodeMirror's own (`search({ createPanel })`); only the panel is ours.

**Verification that ran:** app typecheck clean; app suite 114 suites / 1013 tests pass; design-preview build passes;
19 deliberate breakages (hint, neighbour, close sets, cancel and failed-save handling, tabs outside Files, a discard
fallback, ⌘W wiring, the sheet's answers, tree reveal, match count, wrap, cap, the stock panel, a docked panel, the
invalid-pattern text) — every one failed a test. Driven with real key and mouse events in the preview (Electron,
offscreen): find 9/9 (⌘F focuses the field, typing selects "1 of 5", ↩ / ⇧↩, ⌥⌘C, ⌘↩ replace all, "No results", Esc
closes and returns focus to the code) and tabs 8/8 (click, →, tree button, tabs kept, tree opens on the file,
middle-click). An earlier test caught a missing Settings → Reduce motion twin for the widget's animation.

**Not verified:** the native sheet and the right-click menu are main-process pieces the preview cannot show; they are
unit-tested, not yet clicked in the real app. ⌘W and ⌃Tab live in App.tsx, which the preview does not render.

## Batch 5 — item 11, the jitter when a panel opens (2026-09-30)

**Measured first**, in the built renderer (`out/renderer`) run in Electron with the journeys' bridge stand-in,
recording each frame's width of the conversation, the pane and the flying glass shell while ⌘J / ⌘B toggled them:

| | largest single-frame move of the conversation | how it moved |
|---|---|---|
| right panel closing | 57 px | with the edge, frame by frame (fixed 2026-09-13) |
| **right panel opening, before** | **401 px** | the pane took its full width in ONE frame (967 → 566 px, all text rewrapped), then the glass swept in over ~600 ms |
| **right panel opening, after** | **42 px** | with the edge, frame by frame |
| **sidebar opening, before → after** | **204 → 23 px** | same defect, same fix |

That is the jitter the owner saw "when right panel opens": opening had been left out of the 2026-09-13 fix
(`pane.flight.ts` said "Opening is untouched"). Now `followFlight` runs the same layout override in both directions.
Two traps found on the way, both measured: a just-mounted pane is drawn with the panel library's placeholder
`flex: 1` (11.7 px) until the group lays it out, so its width is read from the group's layout, not its box; and the
override has to take hold at zero width on the first frame, because the library sizes the pane after the flight's
first frame and waiting for it painted one full-width frame. The morph driver's resize observer is now started
before the first paint too (a layout effect).

**Menus and popovers**, measured the same way (Long Animation Frames, three opens each of the permission and model
menus): after the first open, no frame over 17 ms. The FIRST open of each stalls 150–390 ms, with no script, style
or layout time attributed — compositor work, most likely first-time raster of the glass in this software-rendered
harness. **Not settled here:** it needs the real GPU window, and is left open.

**Verification that ran:** app typecheck clean; app suite 115 suites / 1019 tests pass; 10 deliberate breakages
(opening left untouched, waiting for the layout instead of holding at zero, holding at the placeholder box, no clamp
to the target, never releasing at rest, following under Reduce Motion, an uncaught layout read, separators counted
as space, the observer after paint, the sidebar unwired) — every one failed a test. The timing and feel of the
flight itself are unchanged.

## Batch 6 — item 10, left and middle panel parity (2026-09-30, owner: "ur call")

**Measured on the installed window** (`screencapture -l`, the owner's own session): sidebar (33,34,36), conversation
(29,29,30), right pane (36,37,39), right pane's top band (42,43,45). The sidebar/conversation step is 4 levels —
exactly their tints' difference at α 0.74 — with no line between them. The owner's window runs at **120% zoom**
(Chromium `per_host_zoom_levels` = 1.0), and at that zoom the sidebar's top row is ~38px short: its name read **"Bi…"**
next to a conversation column with no top row at all, i.e. one column with a window title and one without.

Changed:
- The sidebar's name is shown whole or hidden, never cut: its row is a query container and the name gives way under
  117px of content box (measured in the built renderer: shown in full at 100%, 47px; hidden at 120%).
- The pinned sidebar lost its own `backdrop-filter`. It was the only pane with one; pinned it sits over the
  transparent window, where macOS already frosts the desktop, so on screen it painted nothing (the measured step is
  the tint difference alone) and cost a compositor pass on a full-height layer every frame a pane flies. The peek,
  over live text, keeps its blur.

**Decided 2026-09-30 by the owner, shown both side by side:** keep the step ("A is a lot better"). Item 10 is closed.

**Deliberately not changed:** the conversation being the darkest surface. It is the recorded, Cursor-matched ladder
(`styles.css`, "THE SAME ALPHA EVERYWHERE; THE TINT IS WHAT DIFFERS") and it is 4 levels here. Whether the owner wants
the sidebar and the conversation as one surface is a taste call to show them, not to make for them.

**Verification that ran:** app typecheck clean; app suite 115 suites / 1021 tests pass; 5 deliberate breakages (the
pinned blur back, the peek's blur gone, the name truncating, no container, the threshold on the border box) — every
one failed a test, the second only after the check was anchored to the unprefixed property. **Not yet installed:**
the installed build (from 9a8f56d) predates this.

## Batch 7 — item 22, regression coverage for the morph paths (2026-09-30)

**Where it runs, and why not the design preview.** The list asked for the design-preview harness. The preview does not
render `App.tsx`, and the side panes' flights are wired there — item 11's 401px jump lived in exactly that wiring. So
the check drives the **built renderer** (`out/renderer`, the real App) with the journeys' bridge stand-in, in an
offscreen Electron window: `npm run check:morph` (`app/scripts/ui/morph-regression.mjs`). The stand-in and the server
moved out of `harness.mjs` into `renderer.mjs` so a runner without Puppeteer can use them (Puppeteer left the deps at
725b28c, so the journeys themselves still cannot run).

**How.** The page's animation clock is taken over: each real frame advances the morph by exactly 1/60 s, so a run is
deterministic (the baseline came out byte-identical across runs) while layout, ResizeObservers and paint still happen
between frames. Every frame it reads what the DOM holds. 32 flights: the Model menu (open, close, closed mid-open,
reopened mid-close), the seeded model window, a menu that appears in place (file actions), the inspector and the
sidebar (close and open), and Reduce Motion — each at 100% and at **120%, the owner's own zoom**. About 25 s with the
build.

**Two verdicts.** Invariants that always hold or the feel is broken: a flight starts on its trigger; nothing moves an
edge more than 120px in a frame; the box on screen is the box the driver set (so a CSS transition or a clamping class
cannot fight it unseen); content is never clickable below 0.6 opacity; a closing menu folds into its trigger and is
unmounted; the conversation moves at most 80px a frame while a pane flies; a pane's glass keeps its window edge, never
moves vertically and never stretches; nothing (override, shell, clip) is left at rest. And a baseline,
`scripts/ui/morph.golden.json`: frames to rest, the progress curve, the content's reveal and the overshoot of every
flight, with tolerances; `npm run check:morph -- --update` rewrites it, and the commit has to say why. Exit 0 held,
1 regression, 2 invalid run (the renderer threw, or a flight ran long enough in real time for the 1.4 s watchdog to
interfere) — an invalid run is neither a pass nor a failure.

**What the first runs found in the app** (both fixed here, both invisible to the unit tests):

| | measured | fixed |
|---|---|---|
| A scrollbar flashed along the bottom of a side pane on every open and close | The panel library wraps each pane's content in an `overflow: auto` box; a flying pane holds its content at full width inside a narrower pane, so that box scrolled sideways, and the app's styled scrollbars take 10px and paint a grey thumb. The content measured 10px short, the flying glass crept to full height, and the sidebar's opening took **65 frames instead of 44**. | A side pane never scrolls sideways (`styles.css`, permanent: an opening pane is measured before the flight's own rule exists). |
| A side pane's glass stretched like a flying menu | The velocity stretch (≤3%) is right for an object in flight and wrong for a layout edge: about its centre, the inspector's glass pulled **6px off the top and bottom of the window** and off its own edge for the fast frames of every open and close. | No stretch for bars (`controller.ts`), with a unit test. |

Also measured and **left**: the inspector's pinned edge drifts 2px while it opens (its target width is filled in a frame
late and lands ~1px off the panel group's rounding) — the bound is 3px and says so. At 100% the conversation moves at
most 42px a frame (inspector) and 23px (sidebar), the numbers batch 5 measured by hand.

**Harness traps, recorded in the code:** Electron's default profile kept a per-site 120% zoom from an earlier harness
run, so every box came out at 1/1.2 scale — the check now uses a throwaway profile; a morph started before the clock
is taken holds a real frame request that ticks every live morph once with the wall clock — the check drains first;
the stand-in never unsubscribed menu commands, so one command toggled a pane twice; an ESM Electron entry must not
await `whenReady()` at top level (it never returns).

**Verification that ran:** 12 deliberate breakages of the product, every one failed the final check (both zooms) with the right reason:
the old menu spring (k 520), menus closing on the shared dismiss, a width/height transition on the glass (a first
version put it on `.morph-surface`, where a later `.liquid-glass` rule silently replaced it — the breakage was dead,
not the check), item 11's opening put back, chooser menus launched in place, the model window unseeded, content
clickable at 5% reveal, the scrollbar fix removed, bars stretching, Reduce Motion ignored at launch, a closed menu
never unmounted, a settled pane keeping its clip; and the new unit test fails with the stretch put back. App
typecheck clean; app suite 115 suites / 1022 tests pass; design-preview build and motion-token check pass.

**A flaky test fixed on the way:** `conversation.share.test.ts` waited a fixed 20ms for an export that runs in the
background; it failed 1 run in 3 alone (the file was read before it was written, and the export's note landed in the
next test). It now waits for each export's end state; 6/6 alone, and it still fails when the export's write is removed.

**Not covered by the check:** glass, blur and colour (it grades numbers, not pixels); the native window; timing on a
real GPU. The first-open menu stall of batch 5 is still unsettled.

**Installed 2026-09-30 from 1aa166c** (batches 6 and 7 together): four package gates PASS, the packaged notch helper's
self-test passes, the new CSS rule and the controller change confirmed inside `app.asar`, window up in 2 s and still
running minutes later. Previous app kept at `~/Developer/bimax-archive/apps/Bimax.app.before-item22-20260930`. The
build first stopped on the notch helper's OCR self-test: macOS refused accurate text recognition on this Mac
(e5rtError 13) — Copy Text now falls back to the fast recognizer (1aa166c). Not yet felt by hand.

## Item 11, the rest — the first-open pause, measured on a real screen (2026-09-30)

Batch 5 left one question: in the software-rendered harness the FIRST open of each menu stalled 150–390 ms. Measured
now in a visible, GPU-composited window with the app's own window options (transparent, `vibrancy: 'sidebar'`,
hidden-inset title bar), the built renderer at the owner's 120%, real clicks (`sendInputEvent`), Long Animation Frames
and Event Timing:

| run | first open of the first menu | later opens | side panes (open/close) | model window, first open |
|---|---|---|---|---|
| first run on this machine | one 417 ms frame; click → paint 505 ms; close 202 ms; Model #2 100 ms, Permission #1 81 ms | ≤19 ms frames, click → paint 40–56 ms | — | — |
| every later run, even with a brand-new app profile | ≤19 ms frames, click → paint 56–72 ms | same | 0 of ~65 frames over 20 ms, both panes, both ways | 433 ms the first time it was ever opened, then 19 ms — also with a new profile |

Every long frame had **0 ms of script** and 1–2 ms of rendering work: the time is the graphics stack preparing the glass
(background blur plus the masked edge blur) the first time it is drawn. It is kept by macOS per app, outside the app's
profile (`$DARWIN_USER_CACHE_DIR/<bundle id>.helper.GPU/com.apple.metal`; Bimax's has existed since July), so it survives
restarts and reinstalls and returns only when that cache is reset — a macOS update, an Electron upgrade, or macOS
clearing caches under disk pressure.

**Decision (owner: "your call"): no code change.** In steady state nothing stalls. A launch-time warm-up (drawing each
glass variant once, invisibly) could hide the rare one-time pause, but it cannot be verified here without clearing
macOS's own caches, and it would add GPU work to every launch. Item 11 is closed. The scratch measuring script is
described here, not committed: a visible window, the journeys' bridge stand-in, real clicks, Long Animation Frames.

## Batch 8 — item 34, clickable areas of at least 24×24 (2026-09-30)

**Measured first, by clicking, not by box size.** A new check, `npm run check:hit-targets`
(`app/scripts/ui/hit-targets.mjs`), opens the built renderer in the views that carry small controls — the
conversation with a thought line, tool rows and a code block; the sidebar with Bimax Threads; the right panel with a
file open; find in a file; Settings; the Model menu — at 100% and 120%, and for every visible control asks the page
where a click would land around it (`elementFromPoint`, in 0.5px steps). A control passes if some spot on it takes
clicks over 24 × 24 CSS px. Links inside running text are exempt, as WCAG 2.5.8 exempts them.

Most of the app already passed (Copy buttons 24×24, tool rows 28 tall, thread-row actions 24×24, Settings, menus).
What did not:

| control | clickable before | now |
|---|---|---|
| "Thought for 2.4s" | 16 tall | 24 (an invisible ring, `.hit-24`) |
| a file tab's × | 18 × 18 | 24 × 24 (ring; the × is drawn at the same size) |
| find: match case / whole word / regex / in selection | 22 × 20 | 24 × 24 (ring; the toggles 2px apart, not 1, so neighbouring rings do not overlap) |
| find: show replace | 16 × 26 | 24 × 26 (ring) |
| the file's folder path above the editor | 20.5 tall | 24 (real height: it truncates, and its clipping box would cut a ring) |
| file tree rows, sidebar section headers | 23.3, 23.8 | 24 (real height: stacked rows cannot take rings without overlapping) |

`.hit-24` (styles.css) is a transparent `::after` that belongs to the control for hit testing and paints nothing, so
nothing is drawn differently; checked in a render of the right panel with find open. The first run of the check also
found find's Previous / Next / Close at 20.6px — they are 24px and were caught mid-entrance, scaled 0.86; the check now
waits for finite animations to end before it measures.

**Verification that ran:** the check fails on the code before this change (26 findings) and passes after it at both
zooms; 7 deliberate breakages (the ring removed, and each control losing its fix, the toggles back to 1px apart) each
fail it with the control named. The morph regression check still holds every flight; app typecheck clean; app suite
115 suites / 1022 tests pass. The stand-in bridge now takes `fixture.threads`, so a world can show Bimax Threads. Not
yet installed.

## Batch 9 — item 38, reading width, steady numbers, the code face only for code (2026-09-30, 7688b6c)

**Line length, measured** in the built renderer (a long reply's prose, characters per line box):

| window | right panel open | right panel closed |
|---|---|---|
| 1180×800 at 120% (the owner's) | 66 → 66 | 119 → 71 |
| 1180×800 at 100% | 84 → 71 | 146 → 71 |
| 1680×1050 at 120% | 101 → 71 | 179 → 71 |
| 1680×1050 at 100% | 119 → 71 | 186 → 71 |

The reading column grows with the window up to 1180px (an earlier review called the ceiling "a tuning call"), and the
text ran to it. Now a reply's running text — paragraphs, lists, quotes, headings — stops at 34em (≈71 characters of
Inter; the owner's usual layout stays at 66), and the owner's own message bubble wraps at the same width. Code blocks,
tables and tool rows keep the whole column, where width is worth having. Shown to the owner as a before/after picture
with the right panel closed.

**Numbers that change** mostly already had even-width digits (the thinking timer, tool durations, the context meter,
recents' ages, find's count). The ⌘2 bar's live footer timer did not; it does now.

**The code face outside code:** recents' and the home view's ages, the ⌘N badge, the welcome's ⌘2 key, the context
percentage, app health's figures, the evidence count and Settings' status chips were set in the monospace face. They
now use the interface face with tabular digits. File paths, commands, model ids, settings inputs and approval
previews keep monospace — they are code-like. Two unused rules (`.evidence-pill`, `.workflow-index`) were left alone.

**Verification that ran:** 7 new unit tests in `ui.fix.list.test.tsx` (items 34 and 38); 12 deliberate breakages of
the two batches (the measure widened to 60em, code blocks capped, the bubble back to 78%, each face and digit change
undone, and four of item 34's fixes) — every one failed a test. App typecheck clean; app suite 115 suites / 1029 tests
pass; `check:morph`, `check:hit-targets` and the design-preview build pass. Not yet installed.

## Batch 10 — items 24 and 41, a finish you can see and a run that ends on what it did (2026-10-01)

**Item 41, the ending.** Measured first: the app already built an end-of-run "receipt" (`final.receipt.model.ts`,
`const receipt` in App.tsx) and never showed it — computed on every render and dropped. The run ended on the reply,
and what changed and whether it was checked lived only in the right panel's Review.

Now a run that changed files ends on one quiet line in the conversation — the tool rows' own inline language, not a
new card (`04_FRONTEND_PLAN.md`) — with the verdict in words beside a distinct icon, the next move when there is one,
and **Review** to open the right panel on it. Expanding it lists the files (with edit counts) and the checks that ran.

| verdict | the line |
|---|---|
| checked and green | ✓ Changed retry.ts · npm test passed |
| the newest check after the edits failed | ✕ Changed 2 files · npm test failed — "Needs a fix before it can be trusted" |
| no check after the edits, or one that covered only part of the code | ⚠ Changed a.ts · not checked yet — "Not proven yet" |
| only text or media changed | ✓ Changed README.md · no test needed for text or media |
| the run was stopped | ■ Stopped · changed a.ts so far |

No line while the run is going, while a question waits on the person, or when the run changed nothing — a receipt on
every answer is noise. A run is everything after the person's latest message; the engine's review covers the session,
so the line counts the files edited since that message.

**One definition of "checked".** The line and the engine's review lifecycle use the same verdict: the rule moved
out of `src/review/verification.scope.ts` and `review.model.ts` into `src/review/review.verdict.ts`, which imports
nothing (its `path.extname` became a string function with a parity test against the old one), and
`src/protocol/protocol.ts` re-exports it — the only way the window may take engine code
(`module.boundaries.test.ts`). The unshown receipt was not reused: its rule counts a failed check followed by a
green retry as unproven, which the engine calls verified.

**Item 24, the finish.** A step's icon swapped from spinner to ✓/✕ with no transition. Now a step (or a folded group)
that finishes while you watch gives its icon one small settle (220 ms, 6% overshoot); a row that mounts already
finished — history, or scrolled back into view — never animates (`finishTracker`, worked out during render so the
settle starts on the frame the icon changes). The ending line arrives once, 240 ms. Reduce Motion, from macOS or from
Settings, stills both.

**Verification that ran:** 16 new tests (engine: the verdict and the rule's parity with `path.extname`; window: every
verdict, the run boundary, the waiting question, the stopped run, the row's words and Review, the app wiring, the
finish rule, the Reduce Motion twins). 14 deliberate breakages, every one failing a test — two survived the first
round (a red check from before the edit read as a failure; a file named `.md`) and got their cases. Played in the
built renderer: the line appears when the run ends, green and red, expanded. Engine typecheck clean and it bundles;
engine outcome/review suites pass; app typecheck clean; app suite 116 suites / 1042 tests; `check:morph`,
`check:hit-targets`, design-preview build pass. Not yet installed.


## Batch 11 — items 27, 32, 36, the motion ladder (2026-10-01)

**Resumed from the interrupted batch, measured in the built renderer** at 1180×800, 100% and the owner's 120%.
The intended springs were already restored. The baseline was checked against the ladder rather than regenerated
again. Press releases ease out in 120ms; the quick-settings flyout takes the snappy curve; Reduce Motion launches
on the destination and fades, with no moving geometry. Pane edges stay pinned while their width travels.

| surface | entrance before → now, 100% | entrance now, 120% | exit now, 100% / 120% |
|---|---|---|---|
| Model menu | 233 → 217ms | 217ms | 183 / 183ms |
| model window | 383 → 283ms | 267ms | 283 / 233ms |
| right pane | 517 → 300ms | 283ms | 250 / 250ms |
| left pane | 467 → 267ms | 250ms | 233 / 233ms |
| menu appearing in place | 183 → 183ms | 183ms | 67 / 67ms |

Times are the virtual 60Hz frame after which geometry stays within 1px of its destination, not real-GPU latency.
The seeded menu overshoots 0.6%; panes do not overshoot. The original 338ms / ~13% preset is not used for these menus.
Exits are 84–100% of their entrances (the in-place menu is 37%); **the requested ~75% is not uniformly reached**.
The 120px-per-frame speed limit takes precedence on long flights home; the model window's unconstrained close jumped
149px in one frame. No claim that every exit is 75%.

**Two alleged mutation escapes resolved.** The old menu spring was already rejected by baseline drift (exit 1): the
runner wrongly required a ladder-error sentence, even though 1 frame of grid tolerance let its settle time pass.
The old pane spring was genuinely ungradeable (exit 2): after the pane visually settled, its edge-pinned x chased
an independently rounded layout x it could never reach. A pinned bar now rests on its independent width spring;
a zero-width initial measurement still waits for real layout. New inspector/sidebar tests step the physics without
any watchdog and prove the handoff despite a 0.25px layout disagreement. Invalid runs remain invalid, never catches.

**Verification that ran:** 6/6 original built-renderer breakages caught in valid runs, plus 6/6 unit breakages
(each press release, flyout bounce, reduced fade, and the impossible-x rest). Evidence and definitions are under
`front inspo/evidence/2026-10-01/batch11-*`. App typecheck clean; full app suite **116 suites / 1050 tests**;
`check:morph` (32 flights, both zooms), `check:hit-targets`, `check:motion`, `check:design-preview` pass;
`editor.glass.test.ts` remains green. The full suite was run from the repository root (`npx jest app/
--coverage=false --maxWorkers=2`): app/ has no Jest configuration, so the handoff's bare app-directory invocation
cannot transform TypeScript. No tests were loosened or skipped.

**Documents and claim boundary:** guided by product-reset README, 03_PRODUCT_EXAMPLES, 04_FRONTEND_PLAN,
BIMAX_MAC_BUDDY_PRODUCT_VISION, 08_ACCEPTANCE_GATES, competitive/06_HEAD_TO_HEAD_EVALS and X01_BUILD_RUN_PROVE.
This is Implemented and locally measured renderer motion. Native installed-GPU feel and fresh-Mac/public release
qualification remain unmeasured; no competitor win or reactivation of Computer Use is claimed. Not yet installed.


## Batch 12 — item 42, attention has a name (2026-10-01)

**Measured first:** Review, GitHub, tool rows and the run ending already pair their status with words or distinct
icons; file changes have +/− and change letters. The two right-panel attention dots had no consistent hover name,
and the sidebar's dot lacked one too. Settings' Environment and ML Alchemist dots were always on and represented no
state at all. The interrupted working tree already contained the fixes; they were verified rather than rewritten.

Attention now has an accessible image role, a name and a hover explanation in both navigation surfaces. The
meaningless Settings dots are gone. These changes touch attributes and remove decorative marks, without adding
animation or changing control geometry. Semantic interface colours remain the owner's silver hierarchy; code syntax
still carries its own colours (item 31 remains deliberately not planned).

**Verification that ran:** 3/3 deliberate breakages caught (right-panel names, sidebar hover explanation, Settings'
meaningless dots restored), saved as `evidence/2026-10-01/batch12-attention-mutants.json`. The full gates immediately
preceding this commit exercised this exact production code and tests: app typecheck; 116 suites / 1050 tests;
32 morph flights and hit targets at 100% and 120%; motion-token check and design-preview build. No production change
was made between that full pass and this commit; each mutation was restored. No visual-comprehension or screen-reader
user study is claimed. Product-reset 03/04, vision, 08 and the end-state/mutation rules in competitive/06 guided the
check. Implemented, locally verified; not yet installed.

## Batch 13 — items 25, 26, 43, quiet type that remains readable (2026-10-01)

**Measured first:** the two themes already implement the owner's restrained silver accent and a near-black
Moonlight canvas with lighter raised surfaces. Item 31's coral recipe remains deliberately not planned. The old
contrast checker printed quiet-label failures without failing: **88 readable labels below 4.5:1**, worst 1.87:1;
Starlight's editor gutter was 4.01:1. The nominal primary-ink pass did not establish readable supporting text.

Quiet Moonlight inks are lighter, Starlight inks and its gutter darker. Glass densities, separate tonal ladders and
syntax colours remain intact. The checker now builds the preview, measures every readable label against the
composited screenshot at **100% and 120%**, and requires all three real-component surfaces (shell, workbench,
transcript), both themes, windowed/expanded chrome and baseline/Increase Contrast. Missing evidence is a failure.
The development dependency is puppeteer-core; it uses the existing Chrome, without downloading another browser.

**Result:** 1,030 baseline text samples, including 598 code tokens, all clear 4.5:1. The weakest gutter is 4.66:1;
code minima are 5.12:1 Moonlight and 5.32:1 Starlight. Increase Contrast passes too. Files, terminal, review, source
and real chat content are staged, rather than a palette-only swatch comparison.

**Verification that ran:** 4/4 unit breakages (both faint inks, colourful semantic accent, pure-black canvas) and
3/3 compiled-preview breakages (old quiet inks, old gutter, missing Starlight stage) caught in valid runs. Evidence
is under `evidence/2026-10-01/batch13-*`. App typecheck, full **116 suites / 1053 tests**, morph's 32 flights,
hit targets at both zooms, motion tokens and design-preview build pass; editor glass stays green. Product-reset
03/04, vision, 08, competitive/06 and the provided Frontend Feel Engineering field guide guided this change.
Implemented and locally measured; native vibrancy over the full wallpaper range and fresh-Mac release gates remain
unmeasured. No broad competitive or visual-comfort claim. Not yet installed.

## Still open

| # | Item |
|---|---|
| 23–45 | Research principles. Done: 34 (batch 8), 38 (batch 9), 24 and 41 (batch 10). 31 is not planned (its colours conflict with the owner's item 10 choice). |
