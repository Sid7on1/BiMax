import { CapabilityBanner } from './components/CapabilityBanner';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, type GroupImperativeHandle } from 'react-resizable-panels';
import { followCollapse, releaseCollapse, settleCollapse } from './pane.flight';
import { prefersReducedMotion } from './components/ui/motion';
import { useEngine } from './useEngine';
import { useSupervisor } from './useSupervisor';
import { useGit } from './useGit';
import { useWindowChrome } from './useWindowChrome';
import { MorphRegion } from './components/ui/morph/MorphRegion';
import { TitleBar } from './components/TitleBar';
import { EmbeddedBrowserWorkspace } from './components/browser/EmbeddedBrowserWorkspace';
import { useEmbeddedBrowser } from './useEmbeddedBrowser';
import { TaskSidebar } from './components/TaskSidebar';
import { Inspector } from './components/Inspector';
import { EngineStatusBanner } from './components/EngineStatusBanner';
import { CommandPalette } from './components/CommandPalette';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';
import { clearDraft } from './composer.model';
import { RequestModal } from './components/RequestModal';
import { SettingsDialog } from './components/SettingsDialog';
import { WorkspaceSheet, type WorkspaceSheetTab } from './components/WorkspaceSheet';
import { EditorPane } from './components/EditorPane';
import { HomeView } from './components/HomeView';
import { ProjectWelcome } from './components/ProjectWelcome';
import { GalleryView } from './components/GalleryView';
import { MachineHealthDialog } from './components/MachineHealthDialog';
import { ModelDialog } from './components/ModelDialog';
import { Appearance, applyAppearance, savedAppearance } from './appearance';
import { deriveBrowserSession } from './browser.session.model';
import { inspectorTabs, resolveActiveTab, type InspectorTabId } from './inspector.model';
import { buildFinalReceipt } from './final.receipt.model';
import { usePhase9 } from './usePhase9';

/**
 * Bimax for Mac — one calm task workspace.
 *
 * Left: projects and task threads. Centre: the current task — transcript, its one state and
 * progress, and the composer. Right: a single contextual evidence inspector whose lanes appear
 * only once the task has produced that kind of evidence. Terminal: a drawer, on request. Trust
 * Center and workspace knowledge: sheets, on request.
 *
 * That layout is `04_FRONTEND_PLAN.md`'s information architecture, and it removes the two shapes
 * `examples/CURRENT_BIMAX_UI.md` recorded as defects: a sidebar mixing navigation with six
 * implementation tools, and a right side that was both an icon rail and a full dock.
 */

export function App(): React.ReactElement {
  const {
    state, store, submit, interrupt, setControls, sendCommand, query, ingestAttachment, reply, menuSelect,
    clearCompletions, configGet, configSet, catalogGet,
  } = useEngine();
  const { status: supervisorStatus, act: supervisorAct } = useSupervisor();
  const { status: gitStatus, refresh: refreshGit } = useGit(state.project);
  const phase9 = usePhase9(state.project);
  // Publishes `:root[data-chrome]`. Read for the side effect: the glass surfaces are pure CSS.
  useWindowChrome();
  const busy = state.spinner.state !== 'idle' && state.spinner.state !== '';

  /**
   * The sidebar has TWO independent reasons to be visible, and collapsing them into one boolean is
   * what made hover behave like a latch:
   *   `sidebarPinned` — the user clicked. Sticky until they click again.
   *   `sidebarPeek`   — the user is pointing at it. Ends when the pointer leaves the panel.
   * A peek renders as an overlay rather than a layout panel, so merely brushing the control never
   * reflows the transcript underneath it.
   */
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const sidebarOpen = sidebarPinned || sidebarPeek;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /**
   * Both bars collapse back into their own edge, and a panel torn out of the layout on the click
   * cannot animate anything. So each bar has a second flag that LAGS its intent: the panel stays in
   * the layout for as long as the collapse takes, and `MorphRegion` reports back when the flight is
   * done. `…Pinned/Open` is what the user asked for; `…Mounted` is what is on screen.
   */
  const [sidebarMounted, setSidebarMounted] = useState(true);
  const [inspectorMounted, setInspectorMounted] = useState(false);
  useEffect(() => { if (sidebarPinned) setSidebarMounted(true); }, [sidebarPinned]);
  useEffect(() => { if (inspectorOpen) setInspectorMounted(true); }, [inspectorOpen]);
  // A collapsing pane's width follows its shell, and the layout is handed back only once the pane has
  // left it — so the conversation moves with the edge rather than after it. See pane.flight.ts.
  const groupEl = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  useLayoutEffect(() => { if (!sidebarMounted) settleCollapse(groupEl.current, groupRef.current, 'sidebar'); }, [sidebarMounted]);
  useLayoutEffect(() => { if (!inspectorMounted) settleCollapse(groupEl.current, groupRef.current, 'inspector'); }, [inspectorMounted]);
  const [requestedTab, setRequestedTab] = useState<InspectorTabId | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceSheet, setWorkspaceSheet] = useState<WorkspaceSheetTab | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(savedAppearance);
  const [view, setView] = useState<'chat' | 'gallery' | 'browser'>('chat');
  // The browser lane owns main-process WebContentsViews. It is told whether it is on screen so
  // the native view hides on a lane switch — a BrowserView has no z-index and would otherwise
  // sit opaquely on top of the conversation.
  const browserLane = useEmbeddedBrowser(view === 'browser');
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [machineHealthOpen, setMachineHealthOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [composerRevision, setComposerRevision] = useState(0);

  useEffect(() => {
    window.bimax.setAppearance(appearance);
    return applyAppearance(appearance);
  }, [appearance]);

  // --- Evidence lanes, derived from the protocol the task already produced --------------------

  const toolCalls = useMemo(
    () => state.items.flatMap((item) => (item.kind === 'tool' ? [item.call] : [])),
    [state.items],
  );
  const browser = useMemo(() => deriveBrowserSession(toolCalls), [toolCalls]);
  const receipt = useMemo(() => buildFinalReceipt({ review: state.review }), [state.review]);

  const hasProject = state.project.length > 0;

  // Remote position drives the GitHub lane's badge (ahead) and attention dot (behind). Read on
  // project change and whenever git status moves, which is already the app's "something happened
  // in the repo" signal — no extra polling loop.
  const [remote, setRemote] = useState<{ isRepo: boolean; ahead: number; behind: number } | null>(null);
  useEffect(() => {
    if (!hasProject) { setRemote(null); return undefined; }
    let live = true;
    // Optional-call on purpose: a renderer paired with an older preload (dev reload, partial
    // install) would otherwise throw inside an effect and white-screen the entire app over a
    // missing side-panel badge. The lane degrades to "not a repo" instead.
    const read = window.bimax.git?.remote?.();
    if (!read) { setRemote(null); return undefined; }
    void read
      .then((r: unknown) => { if (live) setRemote(r as { isRepo: boolean; ahead: number; behind: number } | null); })
      .catch(() => { if (live) setRemote(null); });
    return () => { live = false; };
  }, [hasProject, state.project, gitStatus]);

  const tabs = useMemo(() => inspectorTabs({
    review: state.review,
    gitStatus,
    hasProject,
    isRepo: remote?.isRepo === true,
    ahead: remote?.ahead ?? 0,
    behind: remote?.behind ?? 0,
  }), [state.review, gitStatus, hasProject, remote]);
  const activeTab = resolveActiveTab(tabs, requestedTab);

  // --- Shell actions --------------------------------------------------------------------------

  const submitTask = useCallback((text: string, engineText?: string) => submit(text, engineText), [submit]);

  const openInspector = useCallback((tab: InspectorTabId) => {
    setRequestedTab(tab);
    setInspectorOpen(true);
  }, []);

  const openFile = useCallback((rel: string) => {
    setOpenFiles((files) => (files.includes(rel) ? files : [...files, rel]));
    setActiveFile(rel);
    setInspectorOpen(true);
    // Clearing the requested lane is what actually reveals the editor: `showEditor` below requires
    // `requestedTab === null`, because the editor and the lanes share one panel. Without this,
    // opening a file FROM the Files lane set every other piece of state correctly and then kept
    // rendering the file tree — the click looked like it did nothing at all. (Going back is
    // `onBackToPanels`, which re-requests the 'files' lane.)
    setRequestedTab(null);
  }, []);

  const closeFile = useCallback((rel: string) => {
    setOpenFiles((files) => {
      const next = files.filter((path) => path !== rel);
      setActiveFile((current) => (current === rel ? next[next.length - 1] ?? null : current));
      return next;
    });
  }, []);

  /** Start a fresh task. One definition, because the sidebar, the palette and ⌘N must agree. */
  const newTask = useCallback(() => {
    // A new thread is a new engine in the same folder; the thread it replaces keeps running (see thread.manager.ts).
    clearDraft(`${state.project}#${state.threadId ?? ''}`);
    setComposerRevision(value => value + 1);
    void window.bimax.threads.create();
    setView('chat');
  }, [interrupt, sendCommand, state.project]);

  const resumeSession = useCallback((id: string) => {
    clearDraft(`${state.project}#${state.threadId ?? ''}`);
    setComposerRevision(value => value + 1);
    window.bimax.send({ t: 'resume', id });
    setView('chat');
  }, [state.project, state.threadId]);

  // New project → the open files and every evidence lane belonged to the old one.
  useEffect(() => {
    setOpenFiles([]);
    setActiveFile(null);
    setRequestedTab(null);
    setInspectorOpen(false);
    setView('chat');
  }, [state.project, state.threadId]);

  /**
   * The inspector reveals itself the first time this task has evidence, and again whenever a lane
   * starts needing attention. It does not re-open on every subsequent change: Apple's sidebar
   * guidance ("avoid hiding it by default to ensure it remains discoverable") argues for showing
   * it, and the plan's calm-workspace goal argues against a pane that keeps springing back after
   * the user closes it.
   */
  // Files and Terminal are places you go on purpose; Review and GitHub are where evidence lands.
  // Only the latter may reveal the panel on their own.
  const utilityLanes = new Set<InspectorTabId>(['files', 'terminal']);
  const evidenceLanes = tabs.filter((tab) => tab.available && !utilityLanes.has(tab.id));
  const evidenceKey = evidenceLanes.length > 0 ? 'has-evidence' : '';
  const attentionKey = evidenceLanes.filter((tab) => tab.attention).map((tab) => tab.id).join(',');
  useEffect(() => {
    if (evidenceKey) setInspectorOpen(true);
  }, [evidenceKey]);
  useEffect(() => {
    if (attentionKey) setInspectorOpen(true);
  }, [attentionKey]);

  /**
   * Keyboard map. Every primary surface is reachable without the mouse, which is both the Terminal
   * quality bar in `04_FRONTEND_PLAN.md` and Apple's Split views guidance that a hidden pane needs
   * more than one way back.
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'n') { event.preventDefault(); newTask(); return; }
      if (mod && key === 'b') { event.preventDefault(); setSidebarPinned((v) => !v); setSidebarPeek(false); return; }
      if (mod && key === 'j') { event.preventDefault(); setInspectorOpen((v) => !v); return; }
      if (mod && key === 'k') { event.preventDefault(); setPaletteOpen((v) => !v); return; }
      if (mod && key === 'o') { event.preventDefault(); void window.bimax.pickFolder(); return; }
      if (mod && key === 't') { event.preventDefault(); openInspector('terminal'); return; }
      if (mod && key === 'e' && openFiles.length > 0) {
        event.preventDefault();
        setInspectorOpen(true);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openFiles.length, newTask]);

  const showHome = view === 'chat' && state.items.length === 0 && !state.hasActiveStream;
  const showEditor = inspectorOpen && openFiles.length > 0 && activeFile !== null && requestedTab === null;
  const latestProblem = [...state.diagnostics].reverse().find((entry) => entry.level !== 'info');

  /**
   * One sidebar, rendered in two places: inside the layout when pinned, and as an overlay when
   * peeking. Building it once means a peek can never drift from the pinned version.
   */
  const sidebarNode = (
    <TaskSidebar
      snapshot={state.snapshot}
      onNewTask={newTask}
      onOpenPalette={() => setPaletteOpen(true)}
      onResume={resumeSession}
      onOpenInspector={openInspector}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenMachineHealth={() => setMachineHealthOpen(true)}
    />
  );

  return (
    // The theme class lives on <html> (appearance.ts) so portalled dialogs inherit it too.
    <div className="flex h-screen flex-col">
      <TitleBar
        project={state.project}
        protocolMismatch={state.protocolMismatch}
        gitStatus={gitStatus}
        sidebarOpen={sidebarOpen}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={() => { setSidebarPinned((v) => !v); setSidebarPeek(false); }}
        onPeekSidebar={() => setSidebarPeek(true)}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onOpenChanges={() => openInspector('review')}
        browserOpen={view === 'browser'}
        onToggleBrowser={() => setView((v) => (v === 'browser' ? 'chat' : 'browser'))}
        appearance={appearance}
        onAppearance={setAppearance}
      />

      {hasProject && state.engine.state !== 'exited' && latestProblem?.level === 'error' && (
        <div className="app-surface flex shrink-0 items-center gap-2 border-b border-amber/25 px-4 py-1.5 text-[12px] text-amber">
          <span className="min-w-0 flex-1 truncate">
            {latestProblem.text.replace(/engine/gi, 'Bimax').replace(/supervisor/gi, 'app')}
          </span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium hover:bg-amber/10 focus-visible:outline-2 focus-visible:outline-ember"
          >
            Open support
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {/*
          Peek: an overlay, not a layout panel. Pointing at the toggle must not reflow the
          transcript, and leaving the panel must put it away again — the two halves of the hover
          contract the old single boolean could not express.
        */}
        {hasProject && !sidebarPinned && sidebarPeek && (
          <div
            onMouseLeave={() => setSidebarPeek(false)}
            /* `calm`, not the house bounce: a peek fires on a passing cursor, and anything springy
               reads as twitchy at that frequency. See the peek-in keyframe's note. */
            className="animate-[peek-in_var(--dur-snappy)_var(--ease-snappy)] absolute inset-y-0 left-0 z-30 w-[248px] border-r border-line shadow-2xl"
          >
            {sidebarNode}
          </div>
        )}
        <Group orientation="horizontal" className="h-full" elementRef={groupEl} groupRef={groupRef}>
          {hasProject && sidebarMounted && (
            <>
              <Panel id="sidebar" defaultSize="18%" minSize="190px" maxSize="30%">
                {/* No `seed`: a persistent bar is a structural width transition and grows from its
                    own edge (Prompt 2 §75). See `MorphRegion`'s header for why the intent tracker
                    was the wrong origin here even though it answers the question correctly. */}
                <MorphRegion
                  open={sidebarPinned}
                  kind="sidebar"
                  onFrame={(frame) => {
                    if (frame.state === 'closing') followCollapse(groupEl.current, 'sidebar', frame.geometry.width, prefersReducedMotion());
                    else if (frame.state === 'opening') releaseCollapse(groupEl.current, 'sidebar');
                  }}
                  onCollapsed={() => setSidebarMounted(false)}
                >
                  <div className="h-full" onMouseLeave={() => setSidebarPeek(false)}>
                    {sidebarNode}
                  </div>
                </MorphRegion>
              </Panel>
              <Separator className="w-px bg-line hover:bg-ember/50 data-[separator-active]:bg-ember" />
            </>
          )}

          <Panel id="task" minSize="34%">
            <div className="app-surface flex h-full flex-col">
              <CapabilityBanner notices={Object.values(state.capabilities)} />
              {!hasProject ? (
                <ProjectWelcome />
              ) : view === 'gallery' ? (
                <GalleryView project={state.project} onResume={resumeSession} onBack={() => setView('chat')} />
              ) : view === 'browser' ? (
                <EmbeddedBrowserWorkspace
                  tabs={browserLane.tabs}
                  activeTabId={browserLane.activeTabId}
                  onSelectTab={browserLane.selectTab}
                  onCloseTab={browserLane.closeTab}
                  onNewTab={browserLane.newTab}
                  onNavigate={browserLane.navigate}
                  onBack={browserLane.back}
                  onForward={browserLane.forward}
                  onReload={browserLane.reload}
                  onApproveAction={() => undefined}
                  onRejectAction={() => undefined}
                />
              ) : (
                <>
                  {supervisorStatus && (
                    <EngineStatusBanner
                      status={supervisorStatus}
                      onAction={supervisorAct}
                      onOpenSupport={() => setSettingsOpen(true)}
                    />
                  )}
                  {showHome ? (
                    <HomeView
                      project={state.project}
                      sessionsTick={state.snapshot?.sessions?.length ?? 0}
                      onBrowseSessions={() => setView('gallery')}
                      onResume={resumeSession}
                    />
                  ) : (
                    <Transcript
                      items={state.items}
                      store={store}
                      onMenuSelect={menuSelect}
                    />
                  )}
                  <Composer
                    key={`${state.threadId}:${composerRevision}`}
                    draftKey={`${state.project}#${state.threadId ?? ''}`}
                    busy={busy}
                    mode={state.mode}
                    tier={state.tier}
                    snapshot={state.snapshot}
                    project={state.project}
                    branch={gitStatus?.branch ?? null}
                    streamedChars={state.streamedChars}
                    completions={state.completions.items}
                    onSubmit={submitTask}
                    onInterrupt={interrupt}
                    onControls={setControls}
                    onCommand={sendCommand}
                    onQuery={query}
                    onIngest={ingestAttachment}
                    onClearCompletions={clearCompletions}
                    onOpenModels={() => setModelsOpen(true)}
                    runtime={supervisorStatus}
                  />
                </>
              )}
            </div>
          </Panel>

          {hasProject && inspectorMounted && (
            <>
              <Separator className="w-px bg-line hover:bg-ember/50 data-[separator-active]:bg-ember" />
              {showEditor ? (
                <Panel id="editor" className="app-surface" defaultSize="46%" minSize="320px" maxSize="65%">
                  <EditorPane
                    open={openFiles}
                    active={activeFile}
                    project={state.project}
                    onSelect={setActiveFile}
                    onClose={closeFile}
                    onBackToPanels={() => setRequestedTab('files')}
                  />
                </Panel>
              ) : (
                <Panel id="inspector" className="app-surface" defaultSize="34%" minSize="300px" maxSize="56%">
                  <MorphRegion
                    open={inspectorOpen}
                    kind="inspector"
                    onFrame={(frame) => {
                      if (frame.state === 'closing') followCollapse(groupEl.current, 'inspector', frame.geometry.width, prefersReducedMotion());
                      else if (frame.state === 'opening') releaseCollapse(groupEl.current, 'inspector');
                    }}
                    onCollapsed={() => setInspectorMounted(false)}
                  >
                    <Inspector
                      tabs={tabs}
                      active={activeTab}
                      onTab={openInspector}
                      onClose={() => setInspectorOpen(false)}
                      review={state.review}
                      gitStatus={gitStatus}
                      checkpoints={state.snapshot?.checkpoints}
                      onRefreshGit={refreshGit}
                      onCommand={sendCommand}
                      project={state.project}
                      onOpenFile={openFile}
                      activeFile={activeFile}
                    />
                  </MorphRegion>
                </Panel>
              )}
            </>
          )}
        </Group>
      </div>

      {hasProject && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => { setPaletteOpen(false); clearCompletions(); }}
          onOpenInspector={openInspector}
          onOpenTerminal={() => openInspector('terminal')}
          onOpenWorkspace={setWorkspaceSheet}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewTask={newTask}
          onOpenGallery={() => setView('gallery')}
        />
      )}

      {hasProject && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onOpenHealth={() => { setSettingsOpen(false); setMachineHealthOpen(true); }}
          onOpenModels={() => { setSettingsOpen(false); setModelsOpen(true); }}
          onOpenInspector={(tab) => { setSettingsOpen(false); openInspector(tab); }}
          phase9={phase9}
          configGet={configGet}
          configSet={configSet}
        />
      )}

      <WorkspaceSheet
        open={workspaceSheet !== null}
        tab={workspaceSheet ?? 'map'}
        onTab={setWorkspaceSheet}
        onClose={() => setWorkspaceSheet(null)}
        snapshot={state.snapshot}
        onCommand={sendCommand}
      />

      {state.request && <RequestModal req={state.request} onReply={reply} />}

      <ModelDialog
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        configGet={configGet}
        configSet={configSet}
        catalogGet={catalogGet}
      />

      {/*
        `phase9`, not `trustReport={null}`. The dialog used to take a TrustReport and was always
        handed null, so it fell through to hardcoded placeholder hardware on every open. The
        TrustReport channel it was waiting for does not exist — `global.d.ts` declares
        `trust.trustReport()` but no main-process handler was ever written for it, and the type
        still describes the Computer Use components that were archived. `phase9` is the feed that
        is genuinely live here, and this component already sits inside its 30-second refresh.
      */}
      <MachineHealthDialog
        open={machineHealthOpen}
        onOpenChange={setMachineHealthOpen}
        phase9={phase9}
      />
    </div>
  );
}
