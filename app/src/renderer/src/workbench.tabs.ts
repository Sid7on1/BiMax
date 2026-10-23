/**
 * The workbench's file tabs (UI fix list item 8).
 *
 * The owner asked for Chrome/Cursor tabs — "tabs, but they are files". The lanes (Files, Review,
 * Terminal, GitHub) stay in the one picker: a strip that mixed four lane chips with file chips was
 * built on 2026-09-19 and rejected as cluttered (`front inspo/13-right-panel-applied.md`). What is
 * here is the logic of a strip that holds files only, kept out of the component so it can be tested
 * without a DOM.
 */

function nameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirsOf(path: string): string[] {
  return path.split('/').slice(0, -1);
}

/**
 * A tab's name, and the folder hint that tells it apart from another open file with the same name.
 *
 * Two `index.ts` tabs read as one file opened twice. Cursor answers with the shortest trailing part
 * of each path that differs — `api` and `web`, not the full paths — and only when names collide, so
 * the common case stays a bare name.
 */
export function tabLabel(openFiles: readonly string[], path: string): { name: string; hint: string } {
  const name = nameOf(path);
  const twins = openFiles.filter((other) => other !== path && nameOf(other) === name);
  if (twins.length === 0) return { name, hint: '' };
  const mine = dirsOf(path);
  // Grow the hint one folder at a time, from the file outwards, until no twin shares it.
  for (let take = 1; take <= mine.length; take++) {
    const hint = mine.slice(-take).join('/');
    if (twins.every((other) => dirsOf(other).slice(-take).join('/') !== hint)) return { name, hint };
  }
  return { name, hint: mine.join('/') || 'project root' };
}

/**
 * Where the strip lands when the tab you are looking at closes: the tab to its right, or the one to
 * its left when it was last — the tab that slides under the pointer, as in every browser. It used to
 * be the LAST open file, wherever that was, so closing the first of five tabs jumped to the fifth.
 */
export function neighbourAfterClose(openFiles: readonly string[], closing: string): string | null {
  const index = openFiles.indexOf(closing);
  if (index < 0) return openFiles[openFiles.length - 1] ?? null;
  return openFiles[index + 1] ?? openFiles[index - 1] ?? null;
}

export type TabCloseAction = 'close' | 'others' | 'right' | 'all';

/** The files a close command on `path` closes, in strip order. */
export function filesToClose(openFiles: readonly string[], path: string, action: TabCloseAction): string[] {
  const index = openFiles.indexOf(path);
  if (index < 0) return [];
  switch (action) {
    case 'close': return [path];
    case 'others': return openFiles.filter((other) => other !== path);
    case 'right': return openFiles.slice(index + 1);
    case 'all': return [...openFiles];
  }
}

/** ⌃Tab / ⌃⇧Tab: the next or previous tab, wrapping round, as browsers do. */
export function cycleTab(openFiles: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (openFiles.length === 0) return null;
  const index = current === null ? -1 : openFiles.indexOf(current);
  if (index < 0) return openFiles[delta === 1 ? 0 : openFiles.length - 1];
  return openFiles[(index + delta + openFiles.length) % openFiles.length];
}

/** The folders to expand, outermost first, so the file tree shows `path` (`src/a/b.ts` → `src`, `src/a`). */
export function ancestorsOf(path: string): string[] {
  const dirs = dirsOf(path);
  return dirs.map((_, index) => dirs.slice(0, index + 1).join('/'));
}

/** What closing tabs needs from the app — injected, so the order of questions can be tested. */
export interface CloseSteps {
  isDirty(path: string): boolean;
  /** Bring the file to the front before asking about it: nobody should answer for a file they cannot see. */
  show(path: string): void;
  /** The Save / Don't Save / Cancel sheet. */
  ask(path: string): Promise<'save' | 'discard' | 'cancel'>;
  save(path: string): Promise<boolean>;
  close(path: string): void;
}

/**
 * Close tabs in strip order. An unsaved one is shown and asked about first; Cancel stops the whole
 * command, as in any Mac app's Close All, and so does a save that fails — closing a file whose save
 * just failed would discard the very edits the person chose to keep. Returns what was closed.
 */
export async function closeTabs(paths: readonly string[], steps: CloseSteps): Promise<string[]> {
  const closed: string[] = [];
  for (const path of paths) {
    if (steps.isDirty(path)) {
      steps.show(path);
      const answer = await steps.ask(path);
      if (answer === 'cancel') break;
      if (answer === 'save' && !(await steps.save(path))) break;
    }
    steps.close(path);
    closed.push(path);
  }
  return closed;
}
