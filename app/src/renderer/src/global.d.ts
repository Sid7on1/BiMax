import type { Inbound, Outbound } from './protocol';
// Type-only import (erased at build time): the supervisor's wire shapes come straight from the
// main process source, so renderer and main can never drift.
import type { SupervisorStatus, CrashRecord } from '../../main/supervisor/types';
import type { TakeoverState } from '../../main/takeover';
import type { AdaptiveDecision, RenderingDecision, RuntimeSignals } from '../../phase9/adaptive.policy';
import type { ProcessProvenanceRecord } from '../../phase9/process.provenance';
import type {
  AlchemistCapabilitySnapshot, EnvironmentCapabilitySnapshot,
} from '../../phase9/workspace.capabilities';

export type { SupervisorStatus, CrashRecord, TakeoverState };

export interface AdaptiveRuntimeSnapshot {
  signals: RuntimeSignals;
  decision: AdaptiveDecision;
  rendering: RenderingDecision;
}

export type RecoveryActionName = 'retry' | 'restartSafe' | 'resume' | 'startMinimal' | 'stop';

export interface GitFile {
  path: string;
  status: string;
  staged: boolean;
  insertions: number;
  deletions: number;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitCommitEntry { hash: string; subject: string; when: string }

export interface FileEntry { name: string; dir: boolean }

export interface FilePreview { content: string; truncated: boolean; size: number; binary: boolean }

export interface SessionMetaRecord {
  id: string;
  title: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  tokenEstimate: number;
}

/** Whether the window owns the whole screen — see `windowChrome()` in `main/index.ts`. */
export type { WindowChromeState } from '../../shared/window.chrome';

export type PermissionDisposition = 'granted' | 'denied' | 'not-determined' | 'unavailable';

export interface CodeSignatureReport {
  kind: 'developer-id' | 'apple-development' | 'local-development' | 'ad-hoc' | 'unsigned' | 'unknown';
  identifier?: string;
  teamIdentifier?: string;
  authority?: string;
  hardenedRuntime: boolean | null;
  gatekeeper: 'accepted' | 'rejected' | 'unknown';
  notarization: 'accepted' | 'rejected' | 'unknown';
}

export interface TrustReport {
  generatedAt: string;
  build: {
    packaged: boolean;
    appVersion: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    osRelease: string;
    minimumMacOS: string;
  };
  permissions: { accessibility: PermissionDisposition; screenRecording: PermissionDisposition };
  components: Array<{
    name: 'engine' | 'macCapability' | 'cuService' | 'cuBridge' | 'desktopHelper';
    label: string;
    present: boolean;
    path?: string;
    source: string;
    computerUseOnly: boolean;
    refusedOverride?: { variable: string; value: string };
    sha256?: string;
    signature?: CodeSignatureReport;
  }>;
  appIntegrity: { executableSha256?: string; signature: CodeSignatureReport };
  release: {
    qualification: 'development' | 'manual-alpha' | 'stable';
    warning: string | null;
    updatePermissionWarning: string;
  };
  coding: { available: boolean; requiresPermissions: string[] };
  computerUse: { available: boolean; blockers: string[] };
  unknowns: string[];
}

export interface ManualAlphaServiceStatus {
  state: 'developer-id' | 'approved-ad-hoc' | 'approval-required' | 'invalid' | 'unavailable';
  ready: boolean;
  canApprove: boolean;
  serviceVersion?: string;
  binary?: string;
  codeDirectoryHash?: string;
  approvedHash?: string;
  approvedAt?: string;
  permissions?: { accessibility: string; screenRecording: string };
  detail: string;
}

import type { EvidenceTimeline, RetentionControl } from '../../shared/evidence.timeline';

export interface GitRemoteInfo {
  isRepo: boolean;
  branch: string;
  remoteUrl: string;
  remoteName: string;
  slug: string;
  hasUpstream: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: number;
  lastFetch: string;
}

export interface GitOpResult { ok: boolean; output: string }

export interface LocalModelEntry {
  id: string;
  label: string;
  runtime: 'ollama' | 'lmstudio' | 'huggingface' | 'llamacpp';
  servable: boolean;
  sizeBytes?: number;
  detail: string;
}
export interface LocalRuntimeEntry {
  id: 'ollama' | 'lmstudio' | 'huggingface' | 'llamacpp';
  label: string;
  installed: boolean;
  running: boolean;
  baseURL?: string;
  models: LocalModelEntry[];
  hint: string;
}
export interface LocalModelReport {
  runtimes: LocalRuntimeEntry[];
  servable: LocalModelEntry[];
  scannedAt: string;
}

/**
 * One tab as the main-process browser manager reports it.
 * Field names mirror `EmbeddedTab` in `main/embedded.browser.manager.ts` exactly — the object
 * crosses IPC unchanged and is handed straight to `BrowserTabBar`'s `TabItem`, so a rename on
 * either side has to be a rename on all three.
 */
export interface EmbeddedBrowserTabState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isAgentActive: boolean;
}

/** The whole browser lane's state, returned by every browser channel so the UI stays in step. */
export interface EmbeddedBrowserState {
  tabs: EmbeddedBrowserTabState[];
  activeTabId: string | null;
}

declare global {
  interface Window {
    bimax: {
      send: (msg: Inbound) => void;
      onMessage: (cb: (msg: Outbound) => void) => () => void;
      onEngineState: (cb: (state: string, detail: string) => void) => () => void;
      onProject: (cb: (dir: string) => void) => () => void;
      supervisor: {
        onStatus: (cb: (status: SupervisorStatus) => void) => () => void;
        getStatus: () => Promise<SupervisorStatus | null>;
        action: (action: { action: RecoveryActionName; sessionId?: string }) => Promise<boolean>;
        crashHistory: () => Promise<CrashRecord[]>;
        diagnostics: () => Promise<string>;
      };
      setAppearance: (appearance: 'auto' | 'moonlight' | 'starlight') => void;
      windowChrome: {
        get: () => Promise<WindowChromeState>;
        onState: (cb: (state: WindowChromeState) => void) => () => void;
      };
      /** The embedded research browser. Pages live in a main-owned BrowserView, never in the DOM. */
      embeddedBrowser: {
        state: () => Promise<EmbeddedBrowserState>;
        newTab: (url?: string) => Promise<EmbeddedBrowserState>;
        selectTab: (id: string) => Promise<EmbeddedBrowserState>;
        closeTab: (id: string) => Promise<EmbeddedBrowserState>;
        navigate: (url: string) => Promise<EmbeddedBrowserState>;
        back: () => Promise<EmbeddedBrowserState>;
        forward: () => Promise<EmbeddedBrowserState>;
        reload: () => Promise<EmbeddedBrowserState>;
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
        setVisible: (visible: boolean) => void;
        credentials: {
          has: (domain: string) => Promise<{ exists: boolean; username?: string }>;
          store: (domain: string, username: string, secret: string) => Promise<boolean>;
          autofill: (domain: string) => Promise<{ ok: boolean; summary: string }>;
        };
      };
      pickFolder: () => Promise<string | null>;
      pickFiles: () => Promise<string[]>;
      /** Absolute path of a dropped File (Electron 32+ removed File.path). */
      pathForFile: (file: File) => string;
      restartEngine: () => Promise<string>;
      providers: {
        localModels: () => Promise<LocalModelReport>;
        credentialStatus: () => Promise<Array<{
          name: string;
          hasKey: boolean;
          keyHint?: string;
          storage: 'keychain' | 'none';
          active: boolean;
        }>>;
        configure: (input: { name: string; apiKey?: string; baseURL?: string }) => Promise<{
          ok: boolean;
          error?: string;
        }>;
      };
      getProject: () => Promise<string>;
      recentProjects: () => Promise<string[]>;
      openProject: (dir: string) => Promise<string | null>;
      rendererReady: () => void;
      phase9: {
        adaptiveState: () => Promise<AdaptiveRuntimeSnapshot | null>;
        processProvenance: () => Promise<ProcessProvenanceRecord[]>;
        environment: () => Promise<EnvironmentCapabilitySnapshot | null>;
        alchemistStatus: () => Promise<AlchemistCapabilitySnapshot | null>;
        reportInteraction: (active: boolean, reduceMotion: boolean) => void;
        onAdaptiveChanged: (cb: (snapshot: AdaptiveRuntimeSnapshot) => void) => () => void;
      };
      git: {
        status: () => Promise<GitStatusResult | null>;
        diff: (file: string, untracked: boolean) => Promise<string>;
        branches: () => Promise<{ current: string; all: string[] }>;
        log: (n: number) => Promise<GitCommitEntry[]>;
        remote: () => Promise<GitRemoteInfo | null>;
        fetch: () => Promise<GitOpResult>;
        pull: () => Promise<GitOpResult>;
        push: (setUpstream: boolean) => Promise<GitOpResult>;
      };
      files: {
        list: (rel: string) => Promise<FileEntry[]>;
        read: (rel: string) => Promise<FilePreview>;
        reveal: (rel: string) => Promise<void>;
        search: (query: string) => Promise<{ hits: { rel: string; name: string; dir: boolean }[]; truncated: boolean }>;
        write: (rel: string, content: string) => Promise<void>;
        onChanged: (cb: () => void) => () => void;
      };
      sessionsMeta: () => Promise<SessionMetaRecord[]>;
      trustReport: () => Promise<TrustReport | null>;
      manualAlpha: {
        status: () => Promise<ManualAlphaServiceStatus | null>;
        approve: (codeDirectoryHash: string) => Promise<ManualAlphaServiceStatus | null>;
        revoke: () => Promise<ManualAlphaServiceStatus | null>;
      };
      /** Contextual evidence — a derived timeline and the retention controls (Phase 8, section 28). */
      evidence: {
        timeline: (taskIntentId?: string) => Promise<EvidenceTimeline | null>;
        retentionControls: (taskIntentId?: string) => Promise<RetentionControl[]>;
        remove: (scope: 'task' | 'observations' | 'all', taskIntentId?: string) => Promise<number>;
      };
      exportDiagnostics: () => Promise<'saved' | 'cancelled' | 'failed'>;
      openPermissionSettings: (which: 'accessibility' | 'screenRecording') => Promise<boolean>;
      /**
       * The drag coach. Add-by-drag panes receive a compact native drag tile; `setInteractive` is
       * retained only for compatibility with older main-process bundles.
       */
      permissionCoach: {
        start: (which: 'accessibility' | 'screenRecording' | 'fullDisk' | 'microphone') => Promise<boolean>;
        startService: (which: 'accessibility' | 'screenRecording') => Promise<boolean>;
        stop: () => Promise<boolean>;
        setInteractive: (interactive: boolean) => void;
        dragBundle: () => void;
        bundlePath: () => Promise<string>;
        probe: () => Promise<{
          readings: Record<string, 'granted' | 'denied' | 'not-determined' | 'unavailable'>;
          readingSource: 'helper' | 'in-process';
          responsibleBundle: string;
          responsibleName: string;
          isDevHost: boolean;
        } | null>;
        relaunch: () => Promise<boolean>;
        requestMicrophone: () => Promise<boolean>;
      };
      takeover: {
        get: () => Promise<TakeoverState>;
        set: (request: { paused: boolean; reason?: string }) => Promise<TakeoverState>;
        onState: (cb: (state: TakeoverState) => void) => () => void;
      };
      pty: {
        create: (cols: number, rows: number) => Promise<number>;
        input: (id: number, data: string) => void;
        resize: (id: number, cols: number, rows: number) => void;
        kill: (id: number) => void;
        onData: (cb: (id: number, data: string) => void) => () => void;
        onExit: (cb: (id: number, code: number) => void) => () => void;
      };
    };
  }
}

export {};
