import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useEngine } from './useEngine';
import { useSupervisor } from './useSupervisor';
import { useGit } from './useGit';
import { useTakeover } from './useTakeover';
import { useTrust } from './useTrust';
import { useWindowChrome } from './useWindowChrome';
import { MorphRegion } from './components/ui/morph/MorphRegion';
import { TitleBar } from './components/TitleBar';
import { TaskSidebar } from './components/TaskSidebar';
import { Inspector } from './components/Inspector';
import { TerminalDrawer } from './components/TerminalDrawer';
import { EngineStatusBanner } from './components/EngineStatusBanner';
import { CommandPalette } from './components/CommandPalette';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';
import { RequestModal } from './components/RequestModal';
import { SettingsDialog } from './components/SettingsDialog';
import { PermissionsDialog } from './components/PermissionsDialog';
import { WorkspaceSheet, type WorkspaceSheetTab } from './components/WorkspaceSheet';
import { EditorPane } from './components/EditorPane';
import { HomeView } from './components/HomeView';
import { ProjectWelcome } from './components/ProjectWelcome';
import { GalleryView } from './components/GalleryView';
import { MachineHealthDialog } from './components/MachineHealthDialog';
import { ModelDialog } from './components/ModelDialog';
import { Appearance, applyAppearance, savedAppearance } from './appearance';
import { deriveMacSession } from './mac.session.model';
import { deriveBrowserSession } from './browser.session.model';
import { inspectorTabs, resolveActiveTab, type InspectorTabId } from './inspector.model';
import { buildFinalReceipt } from './final.receipt.model';
import { needsTrustCenterBeforeRun, type TaskLane } from './lane.inference';
import { usePhase9 } from './usePhase9';
import { computerUseModelReadiness } from './computer.use.model';
import { buildComputerUseExecutionPrompt } from './computer.use.prompt';
import { isRoutineAppOwnedMacPrompt } from './mac.approval.model';

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
    state, submit, interrupt, setControls, sendCommand, query, reply, menuSelect,
    clearCompletions, configGet, configSet, catalogGet,
  } = useEngine();
  const { status: supervisorStatus, act: supervisorAct } = useSupervisor();
  const { status: gitStatus, refresh: refreshGit } = useGit(state.project);
  const { takeover, pause, resume } = useTakeover();
  const { report: trustReport, refresh: refreshTrust } = useTrust();
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
  const [requestedTab, setRequestedTab] = useState<InspectorTabId | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const [workspaceSheet, setWorkspaceSheet] = useState<WorkspaceSheetTab | null>(null);
  /**
   * A Control Mac request the user made before Bimax could operate the Mac.
   *
   * `04_FRONTEND_PLAN.md`: "Code tasks enter immediately. The first Control Mac task opens a short
   * contextual Trust Center… and returns to the waiting task." The instruction is held here, not
   * discarded and not sent — sending it would make the model discover the permission problem for
   * itself, which is how the old build produced a confusing half-run.
   */
  const [waitingMacTask, setWaitingMacTask] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(savedAppearance);
  const [view, setView] = useState<'chat' | 'gallery'>('chat');
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [machineHealthOpen, setMachineHealthOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelPurpose, setModelPurpose] = useState<'general' | 'computer-use'>('general');
  const macTaskConsentRef = useRef({ active: false, started: false });

  /**
   * Submit one explicitly selected Control Mac turn. The packaged engine predates the native
   * provider's internal-approval marker, so it emits a duplicate generic MCP prompt before every
   * call. The renderer answers only that exact prompt while this turn is active; all provider
   * policy, sensitive-surface blocks, takeover and taint prompts remain intact.
   */
  const submitMacTask = useCallback((text: string) => {
    macTaskConsentRef.current = { active: true, started: false };
    submit(text, buildComputerUseExecutionPrompt(text));
  }, [submit]);

  useEffect(() => {
    const consent = macTaskConsentRef.current;
    if (!consent.active) return;
    if (busy) consent.started = true;
    else if (consent.started) macTaskConsentRef.current = { active: false, started: false };
  }, [busy]);

  const routineMacRequest = isRoutineAppOwnedMacPrompt(
    state.request,
    macTaskConsentRef.current.active,
  );

  useEffect(() => {
    if (!routineMacRequest || !state.request) return;
    reply(state.request.id, 'Yes');
  }, [reply, routineMacRequest, state.request]);

  useEffect(() => {
    window.bimax.setAppearance(appearance);
    return applyAppearance(appearance);
  }, [appearance]);

  // --- Evidence lanes, derived from the protocol the task already produced --------------------

  const toolCalls = useMemo(
    () => state.items.flatMap((item) => (item.kind === 'tool' ? [item.call] : [])),
    [state.items],
  );
  // One clock read per render, shared by every freshness calculation — an evidence age that
  // disagreed with itself across two panels would be worse than no age at all.
  const mac = useMemo(
    () => deriveMacSession(toolCalls, { paused: takeover.paused, reason: takeover.reason }, Date.now()),
    [toolCalls, takeover.paused, takeover.reason],
  );
  const browser = useMemo(() => deriveBrowserSession(toolCalls), [toolCalls]);
  const receipt = useMemo(() => buildFinalReceipt({ review: state.review, mac }), [state.review, mac]);

  const hasProject = state.project.length > 0;

  const tabs = useMemo(() => inspectorTabs({
    review: state.review,
    gitStatus,
    mac,
    subagents: state.subagents,
    hasProject,
    browserUrl: browser.currentUrl,
    runtimeAvailable: phase9.runtime !== null,
    processCount: phase9.processes.length,
    environmentAvailable: phase9.environment !== null,
    environmentToolCount: phase9.environment?.tools.filter((tool) => tool.state === 'ready').length,
    alchemistAvailable: phase9.alchemist !== null,
    alchemistBackendCount: phase9.alchemist?.backends.filter((backend) => backend.state === 'ready').length,
  }), [
    state.review, gitStatus, mac, state.subagents, hasProject, browser.currentUrl,
    phase9.runtime, phase9.processes.length, phase9.environment, phase9.alchemist,
  ]);
  const activeTab = resolveActiveTab(tabs, requestedTab);

  // --- Shell actions --------------------------------------------------------------------------

  /**
   * Run an instruction, or hold it behind the contextual Trust Center when it needs the Mac and the
   * Mac is not available yet. A code task is never held.
   */
  const submitTask = useCallback((text: string, lane: TaskLane = 'code') => {
    if (lane !== 'mac') {
      submit(text);
      return;
    }
    setWaitingMacTask(text);
    void Promise.all([configGet(), catalogGet(false)]).then(([config, catalog]) => {
      if (!computerUseModelReadiness(config, catalog).ready) {
        setModelPurpose('computer-use');
        setModelsOpen(true);
        return;
      }
      if (needsTrustCenterBeforeRun('mac', trustReport?.computerUse ?? null)) {
        setTrustOpen(true);
        return;
      }
      submitMacTask(text);
      setWaitingMacTask(null);
    });
  }, [catalogGet, configGet, submit, submitMacTask, trustReport]);

  /**
   * Leaving the Trust Center: re-read the report, and release the waiting task only if Bimax can
   * now actually operate the Mac. If the user declined, the task stays waiting and visible rather
   * than being run into a refusal.
   */
  const closeTrust = useCallback(() => {
    setTrustOpen(false);
    if (!waitingMacTask) return;
    void Promise.all([refreshTrust(), configGet()]).then(([value]) => {
      if (!value?.computerUse.available) return;
      submitMacTask(waitingMacTask);
      setWaitingMacTask(null);
    });
  }, [waitingMacTask, refreshTrust, configGet, submitMacTask]);

  const openInspector = useCallback((tab: InspectorTabId) => {
    setRequestedTab(tab);
    setInspectorOpen(true);
  }, []);

  const openFile = useCallback((rel: string) => {
    setOpenFiles((files) => (files.includes(rel) ? files : [...files, rel]));
    setActiveFile(rel);
    setInspectorOpen(true);
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
    sendCommand('/clear force');
    setView('chat');
  }, [sendCommand]);

  const resumeSession = useCallback((id: string) => {
    window.bimax.send({ t: 'resume', id });
    setView('chat');
  }, []);

  // New project → the open files and every evidence lane belonged to the old one.
  useEffect(() => {
    setOpenFiles([]);
    setActiveFile(null);
    setRequestedTab(null);
    setInspectorOpen(false);
    setTerminalOpen(false);
    setView('chat');
  }, [state.project]);

  /**
   * The inspector reveals itself the first time this task has evidence, and again whenever a lane
   * starts needing attention. It does not re-open on every subsequent change: Apple's sidebar
   * guidance ("avoid hiding it by default to ensure it remains discoverable") argues for showing
   * it, and the plan's calm-workspace goal argues against a pane that keeps springing back after
   * the user closes it.
   */
  const utilityLanes = new Set<InspectorTabId>(['files', 'runtime', 'environment', 'alchemist']);
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
      if (mod && event.shiftKey && key === 't') { event.preventDefault(); setTrustOpen((v) => !v); return; }
      if (mod && event.shiftKey && key === 'p') {
        event.preventDefault();
        if (mac.active) (takeover.paused ? resume() : pause('You took control from Bimax'));
        return;
      }
      if (mod && key === 'n') { event.preventDefault(); newTask(); return; }
      if (mod && key === 'b') { event.preventDefault(); setSidebarPinned((v) => !v); setSidebarPeek(false); return; }
      if (mod && key === 'j') { event.preventDefault(); setInspectorOpen((v) => !v); return; }
      if (mod && key === 'k') { event.preventDefault(); setPaletteOpen((v) => !v); return; }
      if (mod && key === 'o') { event.preventDefault(); void window.bimax.pickFolder(); return; }
      if (mod && key === 't') { event.preventDefault(); setTerminalOpen((v) => !v); return; }
      if (mod && key === 'e' && openFiles.length > 0) {
        event.preventDefault();
        setInspectorOpen(true);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openFiles.length, mac.active, takeover.paused, pause, resume, newTask]);

  const showHome = view === 'chat' && state.items.length === 0 && !state.streaming && !state.thinking;
  const showEditor = inspectorOpen && openFiles.length > 0 && activeFile !== null && requestedTab === null;
  const latestProblem = [...state.diagnostics].reverse().find((entry) => entry.level !== 'info');
  // The app-owned report is the authority on whether Bimax can operate the Mac; a blocked runtime
  // state is a symptom, not the fact.
  const computerUseBlocked = trustReport ? !trustReport.computerUse.available : mac.state === 'blocked';

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
      onOpenTrust={() => setTrustOpen(true)}
      onOpenInspector={openInspector}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenMachineHealth={() => setMachineHealthOpen(true)}
      computerUseBlocked={computerUseBlocked}
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
        onOpenChanges={() => openInspector('code')}
        onOpenTrust={() => setTrustOpen(true)}
        appearance={appearance}
        onAppearance={setAppearance}
      />

      {hasProject && state.engine.state !== 'exited' && latestProblem?.level === 'error' && (
        <div className="app-surface flex shrink-0 items-center gap-2 border-b border-amber/25 px-4 py-1.5 text-[12px] text-amber">
          <span className="min-w-0 flex-1 truncate">
            {latestProblem.text.replace(/engine/gi, 'Bimax').replace(/supervisor/gi, 'app')}
          </span>
          <button
            onClick={() => setTrustOpen(true)}
            className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium hover:bg-amber/10 focus-visible:outline-2 focus-visible:outline-ember"
          >
            Open Trust Center
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
        <Group orientation="horizontal" className="h-full">
          {hasProject && sidebarMounted && (
            <>
              <Panel id="sidebar" defaultSize="18%" minSize="190px" maxSize="30%">
                {/* No `seed`: a persistent bar is a structural width transition and grows from its
                    own edge (Prompt 2 §75). See `MorphRegion`'s header for why the intent tracker
                    was the wrong origin here even though it answers the question correctly. */}
                <MorphRegion
                  open={sidebarPinned}
                  kind="sidebar"
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
              {!hasProject ? (
                <ProjectWelcome />
              ) : view === 'gallery' ? (
                <GalleryView project={state.project} onResume={resumeSession} onBack={() => setView('chat')} />
              ) : (
                <>
                  {supervisorStatus && (
                    <EngineStatusBanner
                      status={supervisorStatus}
                      onAction={supervisorAct}
                      onOpenSupport={() => setTrustOpen(true)}
                    />
                  )}
                  {waitingMacTask && (
                    <div
                      className="flex shrink-0 items-center gap-2 border-b border-amber/25 bg-amber/8 px-6 py-2 text-[12px] text-amber"
                      role="status"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        Waiting to run “{waitingMacTask}” — Bimax needs your permission to operate your Mac first.
                      </span>
                      <button
                        onClick={() => setTrustOpen(true)}
                        className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium hover:bg-amber/10 focus-visible:outline-2 focus-visible:outline-ember"
                      >
                        Review permissions
                      </button>
                      <button
                        onClick={() => setWaitingMacTask(null)}
                        className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[11px] text-amber/80 hover:bg-amber/10 focus-visible:outline-2 focus-visible:outline-ember"
                      >
                        Discard
                      </button>
                    </div>
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
                      streaming={state.streaming}
                      thinking={state.thinking}
                      busy={busy}
                      onMenuSelect={menuSelect}
                    />
                  )}
                  <TerminalDrawer open={terminalOpen} project={state.project} onClose={() => setTerminalOpen(false)} />
                  <Composer
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
                    onClearCompletions={clearCompletions}
                    onOpenModels={() => { setModelPurpose('general'); setModelsOpen(true); }}
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
                      mac={mac}
                      onPause={() => pause('You took control from Bimax')}
                      onResume={resume}
                      browser={browser}
                      receipt={receipt}
                      subagents={state.subagents}
                      todos={state.todos}
                      phase9={phase9}
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
          onOpenTerminal={() => setTerminalOpen(true)}
          onOpenTrust={() => setTrustOpen(true)}
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
          onOpenHealth={() => { setSettingsOpen(false); setTrustOpen(true); }}
          onOpenModels={() => { setSettingsOpen(false); setModelPurpose('general'); setModelsOpen(true); }}
          onOpenInspector={(tab) => { setSettingsOpen(false); openInspector(tab); }}
          phase9={phase9}
          configGet={configGet}
          configSet={configSet}
        />
      )}

      {/*
        closeTrust, not a bare setState: a Control Mac task held back for permissions is released
        here, and only if the Mac is genuinely available now. Dropping that would leave the user's
        instruction waiting forever with no visible reason.
      */}
      <PermissionsDialog open={trustOpen} onClose={closeTrust} />

      <WorkspaceSheet
        open={workspaceSheet !== null}
        tab={workspaceSheet ?? 'map'}
        onTab={setWorkspaceSheet}
        onClose={() => setWorkspaceSheet(null)}
        snapshot={state.snapshot}
        onCommand={sendCommand}
      />

      {state.request && !routineMacRequest && <RequestModal req={state.request} onReply={reply} />}

      <ModelDialog
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        purpose={modelPurpose}
        onComputerUseReady={() => {
          setModelsOpen(false);
          if (!waitingMacTask) return;
          if (needsTrustCenterBeforeRun('mac', trustReport?.computerUse ?? null)) {
            setTrustOpen(true);
            return;
          }
          void configGet().then(() => {
            submitMacTask(waitingMacTask);
            setWaitingMacTask(null);
          });
        }}
        configGet={configGet}
        configSet={configSet}
        catalogGet={catalogGet}
      />

      <MachineHealthDialog
        open={machineHealthOpen}
        onOpenChange={setMachineHealthOpen}
        trustReport={trustReport}
      />
    </div>
  );
}
