# 54 — What a ⌘2 task's folder limits (backlog F13, record 46 T06)

Written 2026-09-14. Part 1 states today's guarantee accurately. Part 2 designs a read limit. **Nothing in Part 2
is built, and Bimax makes no promise that a task cannot read outside its folder.**

## Part 1: what is true today (checked in the code on 2026-09-14)

**Changes stay in the folder.**
- **File tools** refuse any path outside the task's folder, for reading as well as writing. The check resolves
  symlinks, and covers every path argument, edit and embedded image (`src/tools/thread.scope.ts`,
  `enforceThreadScope`, called from `tool.factory.ts`).
- **Shell commands** run in a macOS sandbox (`sandbox-exec`, `buildProfile` in `src/sandbox/exec.sandbox.ts`). It
  refuses writes everywhere except the task's folder and the shared temporary folders (`/tmp`, `/private/tmp`,
  `/private/var/folders`). A task refuses to run shell commands at all when no sandbox is available.
- **Deletions** go to the Bin through the app, and only inside the folder. Protected items are refused before any
  approval card is shown. Every change asks first, even under bypass or saved permissions.

**Reads and the network are not limited by the folder.**
- The same shell sandbox starts from `(allow default)`. A command a task runs can read any file your user account
  can read, and it can use the network (unless sovereign mode is on, which denies the network).
- Record 46's T06 probe read a file in a sibling folder from a real sandboxed shell.
- The temporary folders it may write to are shared with every other program.

So "a task changes files only in its folder" is true, and "a task can only see its folder" is not.

## What Bimax says now

- **Sidebar:** "Each changes files only in its own folder and asks for its own permissions" replaces "Each keeps
  its own folder and permissions", which could be read as a read limit.
- **Folder rules editor:** "Tasks change files only in this folder. Commands they run can still read other files on
  this Mac."
- **`PRIVACY.md`:** a section on what a ⌘2 task can reach, with the same two facts.

## Part 2: design for a read limit (Target, not built)

Only once this is built and measured may Bimax say that a task cannot read outside its folder.

1. **Declared read roots.**
   - The shell profile denies reads under the home folder, then allows back:
     - the task's folder;
     - the folders the person adds to the task, from the ⌘2 bar, with the same picker as protected items;
     - a fixed toolchain list.
   - Outside home, system and toolchain locations stay readable: `/usr`, `/bin`, `/System`, `/Library`,
     `/Applications`, `/opt/homebrew`.
   - Home-folder toolchain files need an explicit, reviewed list: `~/.gitconfig`, `~/.npmrc`, language caches such
     as `~/.npm` and `~/.cache`. `~/.ssh` stays denied unless the person adds it.
2. **A private temporary folder.**
   - Each task gets `thread-state/<id>/tmp`, set as `TMPDIR`.
   - Writes to the shared `/tmp` and `/private/tmp` are denied.
   - macOS gives every process a per-user temporary folder under `/private/var/folders`, and some tools ignore
     `TMPDIR`. Each tool on the corpus below must be checked before that path is denied.
3. **File tools already refuse reads outside the folder.** They should read the same declared roots, so the two
   paths agree.
4. **The network stays a separate decision.** Sovereign mode already denies it, and file-organizing tasks might
   default to no network later.
5. **Out of scope:** a credential broker, and connector scopes (mail, calendar).

**Measure before switching it on:**
- Re-run T06: it must fail (read denied).
- Run a corpus of ordinary ⌘2 tasks under the new profile, and watch the sandbox-violation log for denials each one
  hits:
  - `git status`;
  - `npm test` in a project;
  - a Python script;
  - `sips` and `qlmanage` on images;
  - `pdftotext` or `mdls` on PDFs;
  - `zip` and `ditto`.
- The profile builder gets mutants in both directions: a read outside the roots must be refused, and a toolchain
  read must still work.
