import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { WindowChromeState } from '../shared/window.chrome';

/**
 * The renderer's only door to the engine. Mirrors the NDJSON protocol 1:1 — `send` takes a
 * protocol Inbound message, `onMessage` yields protocol Outbound messages (src/protocol/protocol.ts
 * in the engine repo; mirrored types live in renderer/src/protocol.ts).
 */
let activeThreadId: string | null = null;
ipcRenderer.on('threads:selected', (_event, value) => { activeThreadId = value.id; });
function subscribe(channel: string, cb: (value: any) => void): () => void {
  const listener = (_event: unknown, value: any) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
const api = {
  threads: {
    list: () => ipcRenderer.invoke('threads:list'),
    onList: (cb: (value: any) => void) => subscribe('threads:list', cb),
    onSelected: (cb: (value: any) => void) => subscribe('threads:selected', cb),
    create: () => ipcRenderer.invoke('threads:new'),
    select: (id: string) => ipcRenderer.invoke('threads:select', id),
    start: (id: string) => ipcRenderer.invoke('threads:start', id),
    stop: (id: string) => ipcRenderer.invoke('threads:stop', id),
    link: (a: string, b: string, enabled: boolean) => ipcRenderer.invoke('threads:link', a, b, enabled),
    context: () => ipcRenderer.invoke('threads:context'),
    onContext: (cb: (value: any) => void) => subscribe('threads:context', cb),
    pickFolder: () => ipcRenderer.invoke('threads:pick-folder'),
    quickSubmit: (prompt: string, options?: { attachments?: unknown[]; root?: string }) => ipcRenderer.invoke('threads:quick-submit', prompt, options),
    hide: () => ipcRenderer.send('threads:hide'),
    approvals: () => ipcRenderer.invoke('threads:approvals'),
    onApprovals: (cb: (value: any) => void) => subscribe('threads:approvals', cb),
    reply: (id: string, requestId: number, value: string, token: string) => ipcRenderer.invoke('threads:reply', id, requestId, value, token),
    // The ⌘2 bar: its own thread, its own message stream, and its size.
    quickCurrent: () => ipcRenderer.invoke('threads:quick-current'),
    onQuickThread: (cb: (value: any) => void) => subscribe('threads:quick-thread', cb),
    onQuickMsg: (cb: (value: any) => void) => subscribe('threads:quick-msg', cb),
    quickReset: () => ipcRenderer.send('threads:quick-reset'),
    quickInterrupt: () => ipcRenderer.send('threads:quick-interrupt'),
    quickResize: (height: number) => ipcRenderer.send('threads:quick-resize', height),
    quickOpen: () => ipcRenderer.send('threads:quick-open'),
    // Undo the newest change a thread made to files (main/thread.undo.ts).
    undoInfo: (id: string) => ipcRenderer.invoke('threads:undo-info', id),
    undo: (id: string) => ipcRenderer.invoke('threads:undo', id),
    // Files dropped on the bar, paths in answers, and stepping through recent bar tasks.
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    openPath: (raw: string, mode: 'preview' | 'reveal') => ipcRenderer.invoke('threads:open-path', raw, mode),
    quickSwitch: (direction: 'older' | 'newer') => ipcRenderer.invoke('threads:quick-switch', direction),
  },
  send: (msg: unknown): void => ipcRenderer.send('engine:send', msg, activeThreadId),
  onMessage: (cb: (msg: unknown) => void): (() => void) => {
    const h = (_e: unknown, msg: unknown): void => cb(msg);
    ipcRenderer.on('engine:msg', h);
    return () => ipcRenderer.removeListener('engine:msg', h);
  },
  onEngineState: (cb: (state: string, detail: string) => void): (() => void) => {
    const h = (_e: unknown, state: string, detail: string): void => cb(state, detail);
    ipcRenderer.on('engine:state', h);
    return () => ipcRenderer.removeListener('engine:state', h);
  },
  onProject: (cb: (dir: string, generation: number) => void): (() => void) => {
    const h = (_e: unknown, dir: string, generation: number): void => cb(dir, generation);
    ipcRenderer.on('app:project', h);
    return () => ipcRenderer.removeListener('app:project', h);
  },
  // Engine supervisor: full typed lifecycle status + validated recovery actions. The renderer
  // gets levers (retry/restart-safe/resume/minimal/stop), never raw process execution.
  supervisor: {
    onStatus: (cb: (status: unknown) => void): (() => void) => {
      const h = (_e: unknown, status: unknown): void => cb(status);
      ipcRenderer.on('supervisor:status', h);
      return () => ipcRenderer.removeListener('supervisor:status', h);
    },
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('supervisor:get-status'),
    action: (action: { action: string; sessionId?: string }): Promise<boolean> =>
      ipcRenderer.invoke('supervisor:action', action),
    crashHistory: (): Promise<unknown[]> => ipcRenderer.invoke('supervisor:crash-history'),
    diagnostics: (): Promise<string> => ipcRenderer.invoke('supervisor:diagnostics'),
  },
  /** Tells main which appearance is showing, so the native vibrancy material matches it. */
  setAppearance: (appearance: 'auto' | 'moonlight' | 'starlight'): void =>
    ipcRenderer.send('app:appearance', appearance),
  // Window chrome (full screen / zoomed). Read-only: the renderer styles itself against the window
  // state, it never drives the window from here.
  windowChrome: {
    get: (): Promise<WindowChromeState> => ipcRenderer.invoke('window:chrome'),
    onState: (cb: (state: WindowChromeState) => void): (() => void) => {
      const h = (_e: unknown, state: WindowChromeState): void => cb(state);
      ipcRenderer.on('window:chrome', h);
      return () => ipcRenderer.removeListener('window:chrome', h);
    },
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('app:pick-folder'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('app:pick-files'),
  /**
   * The absolute path of a dropped File.
   *
   * `File.path` was removed in Electron 32, so a drag-and-drop in the renderer yields a File object
   * with no way back to disk. `webUtils.getPathForFile` is the replacement and it is main-world
   * only, which is why it has to be bridged here rather than called from the composer. Without it a
   * dropped inspection report cannot be located, let alone ingested.
   */
  pathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  /**
   * Write pasted clipboard content to a temporary file and return its path.
   *
   * Pasting is the other half of `pathForFile`: a file copied in Finder arrives with a real path,
   * but a screenshot or a pasted log has none, so without this the composer can only accept
   * context that already exists on disk. Main validates the name and the size; the renderer
   * chooses neither the directory nor the eventual location.
   */
  stashPaste: (name: string, bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('app:stash-paste', name, bytes),
  restartEngine: (): Promise<string> => ipcRenderer.invoke('engine:restart'),
  providers: {
    /** What this machine can run locally, and what is merely downloaded. */
    localModels: (): Promise<unknown> => ipcRenderer.invoke('models:local'),
    credentialStatus: (): Promise<unknown[]> => ipcRenderer.invoke('providers:credential-status'),
    configure: (input: { name: string; apiKey?: string; baseURL?: string }): Promise<unknown> =>
      ipcRenderer.invoke('providers:configure', input),
  },
  getProject: (): Promise<string> => ipcRenderer.invoke('app:get-project'),
  recentProjects: (): Promise<string[]> => ipcRenderer.invoke('app:recent-projects'),
  openProject: (dir: string): Promise<string | null> => ipcRenderer.invoke('app:open-project', dir),
  rendererReady: (): void => ipcRenderer.send('app:renderer-ready'),
  // Phase 9 contextual runtime surface. Both reads are bounded snapshots; the single write can
  // only report interaction/accessibility state and therefore only constrain adaptive work.
  phase9: {
    adaptiveState: (): Promise<unknown> => ipcRenderer.invoke('phase9:adaptive-state'),
    processProvenance: (): Promise<unknown[]> => ipcRenderer.invoke('phase9:process-provenance'),
    environment: (): Promise<unknown> => ipcRenderer.invoke('phase9:environment'),
    alchemistStatus: (): Promise<unknown> => ipcRenderer.invoke('phase9:alchemist-status'),
    reportInteraction: (active: boolean, reduceMotion: boolean): void =>
      ipcRenderer.send('phase9:interaction', { active, reduceMotion }),
    onAdaptiveChanged: (cb: (snapshot: unknown) => void): (() => void) => {
      const h = (_e: unknown, snapshot: unknown): void => cb(snapshot);
      ipcRenderer.on('adaptive:changed', h);
      return () => ipcRenderer.removeListener('adaptive:changed', h);
    },
  },

  // Electron-native dock subsystems (P3): git reads, file tree, pty terminal.
  git: {
    status: (): Promise<unknown> => ipcRenderer.invoke('git:status'),
    diff: (file: string, untracked: boolean): Promise<string> => ipcRenderer.invoke('git:diff', file, untracked),
    branches: (): Promise<unknown> => ipcRenderer.invoke('git:branches'),
    log: (n: number): Promise<unknown> => ipcRenderer.invoke('git:log', n),
    // GitHub lane: remote/branch/ahead-behind, and the three verbs the user drives by clicking.
    remote: (): Promise<unknown> => ipcRenderer.invoke('git:remote'),
    fetch: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke('git:fetch'),
    pull: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke('git:pull'),
    push: (setUpstream: boolean): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('git:push', setUpstream),
  },
  files: {
    list: (rel: string): Promise<unknown> => ipcRenderer.invoke('files:list', rel),
    read: (rel: string): Promise<unknown> => ipcRenderer.invoke('files:read', rel),
    reveal: (rel: string): Promise<void> => ipcRenderer.invoke('files:reveal', rel),
    search: (query: string): Promise<{ hits: { rel: string; name: string; dir: boolean }[]; truncated: boolean }> =>
      ipcRenderer.invoke('files:search', query),
    write: (rel: string, content: string): Promise<void> => ipcRenderer.invoke('files:write', rel, content),
    onChanged: (cb: (generation: number) => void): (() => void) => {
      const h = (_e: unknown, generation: number): void => cb(generation);
      ipcRenderer.on('files:changed', h);
      return () => ipcRenderer.removeListener('files:changed', h);
    },
  },
  /**
   * The embedded research browser. Every page lives in a BrowserView owned by main; the renderer
   * only ever describes WHERE it should be painted and asks for navigation. It never receives a
   * WebContents handle, so a compromised renderer cannot script an arbitrary page.
   */
  embeddedBrowser: {
    state: (): Promise<unknown> => ipcRenderer.invoke('browser:state'),
    newTab: (url?: string): Promise<unknown> => ipcRenderer.invoke('browser:newTab', url),
    selectTab: (id: string): Promise<unknown> => ipcRenderer.invoke('browser:selectTab', id),
    closeTab: (id: string): Promise<unknown> => ipcRenderer.invoke('browser:closeTab', id),
    navigate: (url: string): Promise<unknown> => ipcRenderer.invoke('browser:navigate', url),
    back: (): Promise<unknown> => ipcRenderer.invoke('browser:back'),
    forward: (): Promise<unknown> => ipcRenderer.invoke('browser:forward'),
    reload: (): Promise<unknown> => ipcRenderer.invoke('browser:reload'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send('browser:bounds', bounds),
    setVisible: (visible: boolean): void => ipcRenderer.send('browser:visible', visible),
    /** Domain in, verdict out. The password itself never crosses into the renderer. */
    credentials: {
      has: (domain: string): Promise<{ exists: boolean; username?: string }> =>
        ipcRenderer.invoke('browser:credentials:has', domain),
      store: (domain: string, username: string, secret: string): Promise<boolean> =>
        ipcRenderer.invoke('browser:credentials:store', domain, username, secret),
      autofill: (domain: string): Promise<{ ok: boolean; summary: string }> =>
        ipcRenderer.invoke('browser:credentials:autofill', domain),
    },
  },
  sessionsMeta: (): Promise<unknown> => ipcRenderer.invoke('sessions:meta'),
  // Contextual evidence (Phase 8, owner section 28). Read-only from the renderer's side: it can ask
  // for a derived timeline and it can ask main to delete records, but it can never inject one.
  evidence: {
    timeline: (taskIntentId?: string): Promise<unknown> =>
      ipcRenderer.invoke('evidence:timeline', taskIntentId ?? null),
    retentionControls: (taskIntentId?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('evidence:retention-controls', taskIntentId ?? null),
    remove: (scope: 'task' | 'observations' | 'all', taskIntentId?: string): Promise<number> =>
      ipcRenderer.invoke('evidence:delete', { scope, taskIntentId }),
  },
  exportDiagnostics: (): Promise<'saved' | 'cancelled' | 'failed'> =>
    ipcRenderer.invoke('trust:export-diagnostics'),
  pty: {
    create: (cols: number, rows: number): Promise<number> => ipcRenderer.invoke('pty:create', cols, rows),
    input: (id: number, data: string): void => ipcRenderer.send('pty:input', id, data),
    resize: (id: number, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: number): void => ipcRenderer.send('pty:kill', id),
    onData: (cb: (id: number, data: string) => void): (() => void) => {
      const h = (_e: unknown, id: number, data: string): void => cb(id, data);
      ipcRenderer.on('pty:data', h);
      return () => ipcRenderer.removeListener('pty:data', h);
    },
    onExit: (cb: (id: number, code: number) => void): (() => void) => {
      const h = (_e: unknown, id: number, code: number): void => cb(id, code);
      ipcRenderer.on('pty:exit', h);
      return () => ipcRenderer.removeListener('pty:exit', h);
    },
  },
};

contextBridge.exposeInMainWorld('bimax', api);

export type BimaxApi = typeof api;
