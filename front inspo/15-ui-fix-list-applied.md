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

## Still open

| # | Item |
|---|---|
| 8 | Several open files as tabs in the right panel, and the file tree one click away. |
| 9 | Find/replace: rebuild as a Cursor-style floating card, or remove. |
| 10 | Left and middle panel parity (one blur, radius, border and spacing set). |
| 11 | Jitter in the seeded open/close animations — profile, then fix. |
| 22 | Visual-regression coverage for the morph paths in the design-preview harness. |
| 23–45 | Research principles. Several already hold or were served by the items above (42 in item 18); the rest need picking one by one with the owner. |
