# 12 — The right panel: one tabbed workbench

Owner, 2026-09-19, pointing at Cursor's right panel: *"keep our components in the same place too."*
Reference screenshots: its terminal lane and its markdown lane.

## What Cursor actually does

Three rows, and the third is the only one that scrolls.

1. **Tab strip.** Every open thing is a chip with an icon — tools and files side by side:
   `± Changes` · `⊕ Browser` · `M↓ ARCHITECTURE.md` · `+`. Right-aligned: expand (⤢), hide panel (▯).
2. **Contextual toolbar**, different per tab. For a file: `←` `→`, the breadcrumb `docs › ARCHITECTURE.md`,
   then `Preview | Source`, `⋯`, search, outline. For the terminal: the shell name and a collapse control.
3. **Content**, flush to the edges. A file may show a secondary tree column on its right.

**No panel title, no subtitle, no lane dropdown.** The active tab *is* the title. That is most of why
it reads as compact.

## What we have

Two components in **one slot**, swapped by a mode flag:

```
showEditor = inspectorOpen && openFiles.length > 0 && activeFile !== null && requestedTab === null
```

- `Inspector` — `.evidence-studio-header` with an icon, a title, a **subtitle**, a `<select>` lane
  picker and a close button. Lanes: Files, Changes, Terminal, GitHub.
- `EditorPane` — its own tab strip for open files, plus a "back to panels" button.

So: two chromes, two mental models, a `<select>` where the reference has tabs, and a title block the
reference does not have at all. They already occupy the same position, which makes this a **merge,
not a re-layout** — the good news of this plan.

## The change

### A. One tab identity
`{ kind: 'lane', id: InspectorTabId } | { kind: 'file', path: string }`. The `requestedTab === null`
mode flag disappears with it; selecting a tab is the only state.

### B. Row 1 — the tab strip
Lane chips (Files, Changes, Terminal, GitHub) and open-file chips in one scroller. Active chip on
`--raise-veil`; the rest plain. File chips keep their close affordance and dirty dot. `+` opens a
menu. Right-aligned: expand-to-full-width and hide (⌘J). Replaces **both** the `<select>` and
`EditorPane`'s strip.

### C. Row 2 — the contextual toolbar
| tab | row 2 |
|---|---|
| a file | `←` `→`, breadcrumb, `Preview \| Source` for markdown, search, outline |
| Changes | changed-file count, refresh, expand all |
| Terminal | shell name, new shell, clear |
| GitHub | branch, ahead/behind, fetch |
| Files | filter input (where it already lives) |

### D. Delete the title block
The icon, title, subtitle and lane `<select>` all go. ~54pt of vertical space back, and the thing
the owner called compact.

### E. Later, not now
The secondary tree column beside an open file. Worth it, but it is a layout change inside the lane
rather than a chrome change, and it should land once the chrome is settled.

## What this touches

`inspector.model.ts` (tab identity) · `Inspector.tsx` (header → two rows) · `EditorPane.tsx` (loses
its strip) · `App.tsx` (`showEditor`, `requestedTab`, `openFile`/`closeFile` wiring) ·
`styles.css` (`.evidence-studio-header` and friends).

**The trap to check:** the panel-flight CSS keys off `[data-panel][id="editor"]` and `id="inspector"`
(`styles.css` ~1401-1404), and `followCollapse`/`releaseCollapse` are called with those ids. Merging
the panels means those selectors and calls have to move together or the resize animation silently
stops matching. Verify in `app/design-preview`, and confirm the collapse animation still runs — it is
exactly the kind of path that keeps working in tests while doing nothing on screen.

## Not in this plan

The four items still Target from `09-black-glass-plan.md`: the empty canvas with a centred composer,
recents into the sidebar, sentence-case section headers, and the one accent.
