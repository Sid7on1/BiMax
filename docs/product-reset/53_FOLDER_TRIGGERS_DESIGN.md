# 53 — Folders that act: folder triggers (backlog FL1)

Design written 2026-09-14, before any code, as record 48 asks. The first version was built the same day on this
design; the "Built" section at the end says what is verified and what is not.

## What the first version does

"When a PDF arrives in Downloads, rename it and file it."

1. The person runs a task in a folder with the ⌘2 bar, for example "Rename it by date and move it into Invoices".
2. In the bar's ⋯ menu: **Run this task when files arrive in Downloads** → Any new file / A new PDF / A new image /
   A new document.
3. From then on, while Bimax is open, files that arrive directly in that folder start a **new ⌘2 task** with the
   task's words and the list of new files. Like every task, it asks before changing anything. When it ends, its
   task shows a list of what it changed.
4. The menu bar's **Folder triggers** menu has Pause, Resume and Stop watching for each trigger, and says why a
   limit paused one.

A trigger is saved in Bimax's settings (`folderTriggers`), never written into the folder, like folder rules and
schedules.

## Events: what counts as an arrival

- **Files directly in the folder only.** Files in subfolders are ignored, and so are new folders. That keeps the
  watch cheap on a Downloads folder with thousands of files, and the usual destination ("move it into Invoices") is
  a subfolder, so filing a file never looks like an arrival.
- **A file is known by its inode.** Renaming a file in place is not an arrival. When a file is deleted, its inode is
  forgotten, so a later file that reuses the inode still counts.
- **Unfinished files wait.** Hidden files, Office lock files (`~$…`) and downloads in progress (`.crdownload`,
  `.download`, `.part`, `.partial`, `.tmp`, `.opdownload`, `.aria2`) are not files yet. When a browser renames the
  finished download, that is the arrival.
- **A file must stop changing.** Its size and modification time must stay the same for 3 seconds, and it must not
  be empty (Firefox first creates an empty placeholder).
- **Files that arrive together go in one run.** A run waits while other new files are still being written, but it
  does not wait for a file that has been changing for over a minute.
- **How Bimax notices.** A folder watch (`fs.watch`, FSEvents on macOS) says "something changed", and Bimax then
  lists the folder. It also lists the folder every minute, because a watch can drop events.
- **It counts from now.** Files already in the folder when a trigger is created, when Bimax opens and when a
  trigger is resumed are never arrivals. Files that arrive while Bimax is closed are not handled (Target).

## Loop protection: a run must not trigger itself

A run changes the folder it watches, and FSEvents cannot say who made a change. So the rules do not guess:

1. **Renames are not arrivals** (the inode rule above).
2. **What a run changed through Bimax is its own output.** The folder's undo journal records every file a run
   created, copied, moved or replaced. When a run ends, a new file whose path is in that run's journal entries is
   marked as known and never starts a run. Paths are compared ignoring case on macOS.
3. **Anything else that appeared during a run is run once, as a follow-up.** Shell commands are not in the journal,
   so a file made by `sips` or a converter is unattributed; so is a file the person downloaded meanwhile. Both are
   handled by one follow-up run.
4. **A follow-up that also leaves new files pauses the trigger** instead of running a third time. The notification
   names the files it did not take. A real loop (each run makes a new file) stops after two runs.
5. **No run while another task works in the same folder**, or in a folder inside it or around it, so the journal
   window of a run holds only that run's changes. Bimax already refuses two working tasks in overlapping folders.

## Limits (a narrow first piece of F5)

| Limit | Value | When it is reached |
|---|---|---|
| Runs at a time, per trigger | 1 | New files wait for the run to end |
| Runs per hour, per trigger | 6 | The trigger pauses and says so |
| Files per run | 50 | The rest go in the next run |
| Tasks running in Bimax | 4 (existing) | Nothing starts; tried again in 30 seconds |
| Triggers | 20 | The ⋯ menu says so |
| Folder | not `/` and not the home folder | The ⋯ menu says so |

A paused trigger restarts counting from now when it is resumed, like a paused schedule.

## Undo and the reviewable change list

- Each run is its own task, so its ↶ Undo reverses its changes one at a time, newest first, through the existing
  undo journal (`app/src/main/thread.undo.ts`). Nothing new is undone automatically.
- When a run ends, its task gets a note: "What this run changed (↶ Undo reverses them one at a time, newest
  first): …", or "This run made no changes that ↶ Undo can reverse." Shell commands are not listed; the note
  does not claim they were undoable.
- Approvals are unchanged. A run that needs an answer while the person is away shows the "needs your decision"
  notification (with Allow and Deny when it is a plain yes-or-no question, backlog N1).

## Not in the first version (Target)

- **F4 proper:** one wakeup mechanism for a folder change, a time, a CI result or an answer, which resumes the same
  task. The first version starts a new task per run.
- Files that arrived while Bimax was closed; subfolders; new folders.
- **Folders with an outcome** ("keep this folder ready for my accountant", a queue of what is ready and what needs
  you): the second part of FL1.
- Undoing a whole run in one step (FL4) and approving a described change set once (N13). Until N13, a run still
  asks for each change, which limits how hands-off a trigger can be.
- Wall-clock and spend limits per run (F5, N6).
- Naming who made a change. The journal covers only changes Bimax planned; everything else is treated as a
  possible loop.
- macOS privacy: Bimax itself now lists the watched folder. For Downloads, Desktop or Documents, macOS may ask once
  whether Bimax can access it; if it refuses, the trigger pauses and says it cannot read the folder.

## Code and tests

- `app/src/main/folder.triggers.ts`: arrivals, settling, batching, limits and loop protection behind injected
  dependencies (listing, watch, timer, clock, start, journal), so they are tested without a disk, a clock or
  Electron.
- `app/src/__tests__/folder.triggers.test.ts`: existing files never run; a growing download waits; a rename is not
  an arrival and a finished download is; journaled output is ignored; an unjournaled output makes a follow-up and a
  second one pauses; six runs an hour; 50 files a run; busy waits; a stopped run frees the trigger; pause, resume
  and an unreadable folder; the journal window; saved triggers are re-checked.
- `app/src/main/index.ts`: the ⋯ menu entries, the menu bar's Folder triggers menu, starting a run, the change list
  when a run ends.

## Built 2026-09-14

- **Verified:** `folder.triggers.test.ts` passes 14 tests. 23 mutants of `folder.triggers.ts` each fail a test.
  Three needed a second pass: two did not compile, and one ("take a file while it still grows") survived until the
  long-download test was added. The app type-checks.
- **Not verified:** nothing has run against a real folder yet. Untested until the app is rebuilt and tried live:
  - the folder watch;
  - the macOS privacy prompt;
  - a real browser download;
  - the ⋯ and menu bar entries;
  - the change-list note in a real run.

  The `index.ts` wiring has no unit test.
