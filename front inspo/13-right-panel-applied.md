# 13 — The right panel, merged

What `12-right-panel-plan.md` asked for, built 2026-09-19, then corrected the same day by the owner:
the editor and the inspector are one workbench, and it has **one picker, not a strip of chips**.
Three rows, and only the third scrolls.

## What landed

**A. One tab identity.** `WorkbenchTab = { kind: 'lane'; id } | { kind: 'file'; path }` in
`inspector.model.ts`, resolved by `resolveWorkbenchTab(tabs, requested, openFiles)`. The mode flag is
gone — `showEditor = inspectorOpen && openFiles.length > 0 && activeFile !== null && requestedTab === null`
does not exist any more, and neither does the second meaning of "no lane requested" that made opening
a file from the Files lane look like a dead click. Selecting a tab is the only state.

**B. Row 1, the picker.** One control stating what the panel is showing — a lane with its count, or
a file with its unsaved dot — and a grouped menu behind it: **Evidence** (the four lanes, each with
one line saying what it is for, unavailable ones disabled with the reason) and **Open files** (name
plus its folder, the unsaved dot). Right-aligned: widen and hide (⌘J).

This replaced the `<select>`, `EditorPane`'s own strip — and the chip strip that was built first.
See *Round 2* below.

**C. Row 2, the contextual toolbar.** For a file: `←` `→` through the open files, the folder it
lives in, `modified — ⌘S` while that is true, `Source | Preview` for markdown (rendered from the LIVE
document, so an unsaved edit shows), find-in-file, and one overflow holding `@path`, Reveal in
Finder and Close this file.

Row 2 carries the FOLDER, not the file name: the picker beside it already states the name, and a
two-row header that says the same thing twice is where clutter starts.

**D. The title block is gone.** Icon, title, subtitle and lane `<select>` deleted; the header went
from 54pt to 34pt. The active chip is the title.

## Round 2 — one picker, not a strip

The first build followed the plan exactly: lane chips and file chips side by side in one scroller.
The owner's verdict was that the panel was **not organised** and that the `<select>` it replaced had
at least been clean. That is the correct reading. Four lanes plus a chip per open file is eight
controls competing for 430pt; the strip had already needed a container query to drop the lane labels
and a scroll-into-view to keep the selected chip on screen — two mechanisms whose only job was to
manage crowding the design had created.

So the strip is gone and the picker is one control, with everything inside it, grouped and described.
It is the calm of the old `<select>` with the two things that control never had: the open files are
in it, and every row says what it is for. `.workbench-chip`, `.workbench-strip-divider` and the
`[data-files]` container query went with it.

**The control that OPENS the panel moved too.** It was in the sidebar's footer — "show the panel on
the RIGHT", in the bottom-LEFT corner, as far from the thing it opens as the window allows, and
invisible whenever the sidebar was hidden. It is now the last control in `CanvasChrome`, at the top
right, 12pt from the window's right edge (measured), and it is the only one: three tests pin it
there, pin App to a single handler, and fail if the sidebar ever grows one back.

## Deliberately not built, and why

- **Row 2 for the four lanes.** The plan tabulated one per lane. Each of those controls already
  exists *inside* its panel — Files its filter, Review its refresh and branch row, Terminal its
  restart, GitHub its fetch/pull/push — so a second bar above them would duplicate the chrome that
  deleting the title block was meant to remove. Row 2 appears for a file tab only.
- **The `+` menu.** Every lane and every open file is already one click away in the picker, so a
  second menu would list what the first one lists.
- **"Expand to full width" is a widen.** The task column's `minSize` is 34%, so a full-width panel
  would have to evict the conversation from the layout. The control widens the panel to the widest
  the layout allows — 65% alone, less with the sidebar pinned — and restores the previous width.
- **The secondary tree column** beside an open file: still later, as the plan said.

## What measuring changed

Four labelled lane chips take ~350pt, and the panel opens at 430pt — so with a file open the file
chips were scrolled clean off the end of the strip and the tab you were looking at had no chip on
screen. That measurement, taken in `app/design-preview#workbench` at the width the panel actually
opens at, is what the round-2 rework came from: the crowding was not a tuning problem.

`.evidence-studio` is still a query container, with one rule left: under 360pt row 2 drops the
folder, because the picker already identifies the file and row 2 must never wrap.

## The trap the plan named

The collapse animation keys off the panel ELEMENT by id, and the right side used to mount as
`editor` or `inspector` depending on the mode flag — so `pane.flight.ts` and the `[data-flight-…]`
rules in `styles.css` each had to name both. One workbench, one panel, one id: `PANEL_IDS.inspector`
is `['inspector']` and the CSS names only `inspector`.

Three tests in `phase5.renderer.models.test.ts` hold the three places together — App's mounted panel
ids, `pane.flight.ts`, and the flight CSS — and fail if any of them drifts, in either direction.
Mutants killed: the panel renamed back to `editor` (3 tests fail), a stale `editor` rule left in the
CSS (1), lanes resolved before the requested file (3), a closed file resolving to nothing (1),
`sameTab` comparing by reference (1).

`editor.opens.test.ts` used to assert the coupling itself — that `showEditor` contains
`requestedTab === null`. That pinned the workaround, so it now asserts the property: a file
requested while a lane is selected wins, and the mode flag is gone for good.

## Found on the way (not part of the merge)

1. **`--raise-veil` was frozen to Moonlight inside a Starlight subtree.** A custom property's
   `var()` is substituted where the property is *declared*, and `--raise-veil` was declared only on
   `:root` and in `.theme-moonlight`. The app never saw it (`appearance.ts` puts the theme class on
   `<html>`, the same element), but every side-by-side preview painted raised surfaces #212121 on a
   white panel — the workbench's active chip and its Source/Preview segment were dark pills with
   dark text. `.theme-starlight` now declares `--raise-veil`, `--float-veil` and `--float-solid`
   with the identical expressions: no change on `<html>`, correct on any subtree. **Fixed.**

2. **`check:glass-contrast` had four defects, and they only showed once it was asked to visit a
   second page.** It now measures `#shell` *and* `#workbench` — 155 text nodes, up from 69.
   - a hash-only `goto` does not re-run the app, so the second page silently measured the first
     again (138 nodes that were 69 counted twice);
   - the screenshot was viewport-only, so every node below the fold read pure black;
   - the backdrop probe was one point **12px below the text** — fine on the sidebar's tall rows,
     wrong on a 24px toolbar button, where it sampled the pane *under* the button. It is now the
     dominant colour of a grid inside the element's own box, clipped to the stage;
   - foreground colours were parsed by regex, and Tailwind v4 emits `oklab(…)` for every alpha mix,
     which read as black. The browser resolves the colour now, and alpha is blended against the
     measured backdrop instead of being ignored.
   Disabled controls are skipped (WCAG 1.4.3 exempts them; ours are drawn at 40–45% opacity).
   **Result: primary ink clears AA, and Increase Contrast rescues 63 of 63 quiet nodes.**

3. **The editor is a black slab in Starlight.** `EditorPane`'s CodeMirror theme hardcodes
   `#0d0d0d`/`#eeeeec` and is applied in both themes, so the light theme shows a dark editor under
   light chrome. Pre-existing, visible in the preview's starlight stage, **not fixed** — it is a
   theme decision, not part of this merge.

## Verification

- `app/src/__tests__` — 62 suites, 526 tests, green: the three flight-id guards, the six
  workbench-tab tests and the three that pin the open control to the top right; 5 mutants killed,
  each named above.
- `npx tsc --noEmit` in `app/` (86 renderer files in the program) and `npm run build` — green.
- `npm run check:design-preview` — green; `npm run check:glass-contrast` — green, now covering the
  new surface.
- Looked at in `app/design-preview#workbench`: file tab, every lane, both themes, both window
  states, at 430pt and 900pt — and the picker's menu opened, with both groups on screen.
- The open control measured in place: 12pt from the right edge of the chrome row, after the spacer.

## Still Target

- The collapse animation was **not re-measured in a real window**. Its panel id is held by a test
  and the CSS/TS pair is in sync, but a dev instance was already running under the owner's session
  and was left alone. Press ⌘J with a file open to confirm on screen.
- No motion measurement of the strip itself (chip switch, scroll-into-view).
- The four items still Target from `09-black-glass-plan.md` are untouched: the empty canvas with a
  centred composer, recents into the sidebar, sentence-case section headers, the one accent.
