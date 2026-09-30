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

## Batch 2 (2026-09-30)

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

## Still open

| # | Item |
|---|---|
| 8 | Several open files as tabs in the right panel, and the file tree one click away. |
| 9 | Find/replace: rebuild as a Cursor-style floating card, or remove. |
| 10 | Left and middle panel parity (one blur, radius, border and spacing set). |
| 11 | Jitter in the seeded open/close animations — profile, then fix. |
| 16 | Retune the menu motion (338 ms / ~12.6% overshoot → ~200–240 ms, ≤8%). |
| 22 | Visual-regression coverage for the morph paths in the design-preview harness. |
| 23–45 | Research principles. Several already hold or were served by the items above (42 in item 18); the rest need picking one by one with the owner. |
