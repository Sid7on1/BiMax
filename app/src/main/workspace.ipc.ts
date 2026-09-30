import { dialog, Menu, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';
import type { IpcGate } from './ipc.gate';
import { gitDiff, gitBranches, gitLog, gitRemoteInfo, gitFetch, gitPull, gitPush, stampedGitStatus } from './git';
import { discoverLocalModels } from './local.models';
import { listDir, readFilePreview, writeFileContent, readSessionMeta, searchFiles } from './files';
import { createPty, writePty, resizePty, killPty } from './pty';
import { asBoundedInt, asFileContent, asPtyInput, resolveWithinRoot } from './security';

/** What the workspace panels need from the app: moved out of main/index.ts (flaw list C13). */
export interface WorkspaceIpcHost {
  /** The open project; '' when none is open, and every resolver below then fails closed. */
  projectDir(): string;
  /** Rises on every project switch, so a slow git read cannot be applied to the next project. */
  projectGeneration(): number;
  /** Send to the main window. */
  broadcast(channel: string, ...args: unknown[]): void;
  /** The main window, which the editor tabs' sheet and menu attach to. */
  window(): BrowserWindow | null;
}

/** What closing an unsaved tab asked, answered. */
export type CloseAnswer = 'save' | 'discard' | 'cancel';

/** A command from a file tab's right-click menu (renderer `workbench.tabs.ts`, plus two file verbs). */
export type TabMenuAction = 'close' | 'others' | 'right' | 'all' | 'mention' | 'reveal';

/** The main window's workspace panels: Review (git), Files, the editor's save, Sessions, and the Terminal. */
export function registerWorkspaceIpc(ipc: IpcGate, host: WorkspaceIpcHost): void {
  // Review panel — native git reads (writes go through the engine's /git for attribution).
  // Stamped with the project and generation captured BEFORE the read starts. A `git status` on a
  // large repository is not instant, and without the stamp a reply that began under the previous
  // project would be applied to the current one.
  ipc.handle<unknown>('git:status', null, () => stampedGitStatus(host.projectDir(), host.projectGeneration()));
  // gitDiff contains the pathspec against the project itself — see its doc comment.
  ipc.handle<string>('git:diff', '', (_e, file: unknown, untracked: unknown) =>
    gitDiff(host.projectDir(), file, untracked === true));
  ipc.handle<unknown>('git:branches', { current: '', all: [] }, () => gitBranches(host.projectDir()));
  // GitHub lane. Reads are free; the three network verbs are user-initiated only — nothing here is
  // reachable by the engine or the model, and none of them takes or stores a credential.
  ipc.handle<unknown>('git:remote', null, () => gitRemoteInfo(host.projectDir()));
  // Local model runtimes. Read-only probe of this machine — no network, no credentials.
  ipc.handle<unknown>('models:local', { runtimes: [], servable: [], scannedAt: '' }, () => discoverLocalModels());
  // Filename search for the Files filter. Read-only, bounded, and confined to the project root by
  // the same resolver the tree uses.
  ipc.handle<unknown>('files:search', { hits: [], truncated: false }, (_e, query: unknown) =>
    searchFiles(host.projectDir(), query));
  ipc.handle<unknown>('git:fetch', { ok: false, output: 'unavailable' }, () => gitFetch(host.projectDir()));
  ipc.handle<unknown>('git:pull', { ok: false, output: 'unavailable' }, () => gitPull(host.projectDir()));
  ipc.handle<unknown>('git:push', { ok: false, output: 'unavailable' }, (_e, setUpstream: unknown) =>
    gitPush(host.projectDir(), setUpstream === true));
  ipc.handle<unknown>('git:log', [], (_e, n: unknown) =>
    gitLog(host.projectDir(), n === undefined ? 15 : asBoundedInt(n, 1, 1000, 'git log count')));

  // Files panel — lazy tree + capped read-only viewer. Every path is resolved inside the project;
  // with no project open the resolver fails closed rather than falling back to the filesystem root.
  ipc.handle<unknown>('files:list', [], (_e, rel: unknown) => listDir(host.projectDir(), rel));
  ipc.handle<unknown>('files:read', null, (_e, rel: unknown) => readFilePreview(host.projectDir(), rel));
  ipc.handle<void>('files:reveal', undefined, (_e, rel: unknown) => {
    shell.showItemInFolder(resolveWithinRoot(host.projectDir(), rel, 'reveal path'));
  });
  // Editor pane ⌘S — the user's own edit, so it writes directly like any IDE (agent edits still
  // flow through the engine's tools + Edit Shield).
  ipc.handle<void>('files:write', undefined, (_e, rel: unknown, content: unknown) =>
    writeFileContent(host.projectDir(), rel, asFileContent(content)));

  // The file tabs (fix list item 8). Closing a tab with unsaved edits asks, as a native sheet on the
  // window: a ✕ on every tab made discarding work one stray click away, and the menu's "Unsaved
  // changes will be lost" was a warning after the fact. Esc is Cancel. The name is only shown.
  ipc.handle<CloseAnswer>('files:confirm-close', 'cancel', async (_e, rel: unknown) => {
    const name = typeof rel === 'string' && rel.length <= 1024 ? rel.split('/').pop() || rel : 'this file';
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Save', 'Don’t Save', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Do you want to save the changes you made to ${name}?`,
      detail: 'Your changes will be lost if you don’t save them.',
    };
    const win = host.window();
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  });
  // A tab's right-click menu: native, like the rest of the app's context menus. It answers with the
  // command and the page runs it, so closing still goes through the page's unsaved-changes check.
  ipc.handle<TabMenuAction | null>('files:tab-menu', null, (_e, hasOthers: unknown, hasRight: unknown) =>
    new Promise((resolve) => {
      const pick = (action: TabMenuAction) => () => resolve(action);
      Menu.buildFromTemplate([
        { label: 'Close', click: pick('close') },
        { label: 'Close Others', enabled: hasOthers === true, click: pick('others') },
        { label: 'Close to the Right', enabled: hasRight === true, click: pick('right') },
        { label: 'Close All', click: pick('all') },
        { type: 'separator' },
        { label: 'Insert @path in the Composer', click: pick('mention') },
        { label: 'Reveal in Finder', click: pick('reveal') },
      ]).popup({
        window: host.window() ?? undefined,
        // On macOS the menu can report closing before its item's click runs; a late null is ignored,
        // because a promise settles once.
        callback: () => { setTimeout(() => resolve(null), 150); },
      });
    }));

  // Home dashboard + Sessions gallery: full session history from the engine's meta JSONL.
  ipc.handle<unknown>('sessions:meta', [], () => readSessionMeta(host.projectDir()));

  // Terminal panel — pty lives here so the shell survives renderer tab switches.
  ipc.handle<number>('pty:create', -1, (_e, cols: unknown, rows: unknown) =>
    createPty(host.projectDir(), asBoundedInt(cols, 2, 1000, 'cols'), asBoundedInt(rows, 2, 1000, 'rows'), {
      onData: (id, data) => host.broadcast('pty:data', id, data),
      onExit: (id, code) => host.broadcast('pty:exit', id, code),
    }));
  ipc.on('pty:input', (_e, id: unknown, data: unknown) =>
    writePty(asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, 'pty id'), asPtyInput(data)));
  ipc.on('pty:resize', (_e, id: unknown, cols: unknown, rows: unknown) =>
    resizePty(
      asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, 'pty id'),
      asBoundedInt(cols, 2, 1000, 'cols'),
      asBoundedInt(rows, 2, 1000, 'rows'),
    ));
  ipc.on('pty:kill', (_e, id: unknown) =>
    killPty(asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, 'pty id')));
}
