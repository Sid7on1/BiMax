// The desktop app's protocol module. The WIRE CONTRACT half (PROTOCOL_VERSION, the message
// interfaces, Inbound/Outbound, FORWARDED_EVENTS, sanitizeArgs) is GENERATED verbatim from the
// engine's src/protocol/protocol.ts into ./protocol.gen.ts — never hand-edit that mirror; run
// `npm run gen:app-protocol` and let the CI gate (npm run check:protocol-mirror) enforce it.
//
// This file re-exports the generated contract and adds the RENDERER-ONLY payload shapes the app
// consumes off the wire (event payloads from src/cli/events.ts, the ui_snapshot from
// src/protocol/ui.snapshot.ts) — types the engine doesn't publish in its protocol module.
export * from './protocol.gen';

// --- Renderer-only payload shapes ------------------------------------------------------------

import type { CatalogModelEntry, ProviderEntry } from './protocol.gen';

/**
 * A `catalogResult` with the wire envelope (`t`, `id`) stripped — what the model window actually
 * consumes. `error` is not a failure to swallow: it means the provider's live model list could not
 * be read, so `served` is unknown rather than false, and the UI must say "unverified" instead of
 * hiding models it merely failed to confirm.
 */
export interface EngineCatalog {
  providers: ProviderEntry[];
  models: CatalogModelEntry[];
  error?: string;
}

/** The engine settings the wire exposes (allowlist lives in headless.entry.ts). */
export interface EngineConfig {
  model?: string;
  liteModel?: string;
  fallbackModel?: string;
  subagentModel?: string;
  visionModel?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeout?: number;
  reasoningEffort?: string;
  contextMode?: 'smart' | 'full';
  contextWindowTokens?: number;
  parallelToolCalls?: boolean;
  maxToolIterations?: number;
  maxSubAgents?: number;
  notificationBell?: boolean;
  verbose?: boolean;
  reducedMotion?: boolean;
  theme?: string;
  autoIndex?: boolean;
  gitAutoCommit?: boolean;
  autoVerify?: boolean;
  sandboxBash?: boolean;
  selfCritic?: boolean;
  adversarialVerify?: boolean;
  diffApproval?: boolean;
  blastGate?: boolean;
  showMapPanel?: boolean;
  showTokenMeter?: boolean;
}

// --- Event payloads --------------------------------------------------------------------------

export interface ToolCallEntry {
  id: string;
  toolName: string;
  input: string;
  output: string;
  status: 'running' | 'success' | 'error';
  startTime: string;
  endTime?: string;
  parentId?: string;
  agentLabel?: string;
}

export interface MessageEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  level?: 'info' | 'warn' | 'error' | 'success';
  uiComponent?: string;
  payload?: any;
  content: string;
  thoughtMs?: number;
  timestamp: string;
}

export interface MindWeakSpot {
  tool: string;
  domain: string;
  failRate: number;
  pWeak: number;
  n: number;
  advice: string;
}

export interface MindDrive {
  label: string;
  value: string;
  ok: boolean;
  spark: number[];
}

export interface MindLedger {
  resolved: number;
  open: number;
  expired: number;
  coveragePct: number;
  overconfident: number;
}

/** One sub-agent claim from the engine's blackboard (subagent_update payload). */
export interface SubAgentClaim {
  taskId: string;
  agentType: string;
  scope: string;
  prompt: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  toolCalls: number;
  endedAt?: number;
  result?: string;
  error?: string;
}

/** v2: one saved session for the sidebar list; resume with `/resume <id>`. */
export interface UiSnapshotSession {
  id: string;
  title: string;
  startedAt: string;
  messageCount: number;
  cwd: string;
  current: boolean;
}

// --- Review domain (review_update payload) ----------------------------------------------------
// Mirrors src/review/review.model.ts ReviewSnapshot — the engine's derived, per-thread review
// state. Always a full snapshot; the renderer never accumulates deltas.

export type ReviewStateName =
  | 'idle' | 'planning' | 'awaiting_approval' | 'applying'
  | 'unverified' | 'verification_failed' | 'verified' | 'checkpointed';

export interface ReviewApproval {
  id: number;
  kind: 'permission' | 'diff' | 'question';
  question: string;
  requestedAt: number;
  resolution?: { value: string; approved: boolean; at: number; interrupted?: boolean };
}

export interface ReviewChange {
  file: string;
  tools: string[];
  edits: number;
  lastCallId?: string;
  lastAt: number;
}

export interface ReviewVerification {
  command: string;
  ok: boolean;
  settled: number;
  coveredFiles: string[];
  repoWide: boolean;
  at: number;
}

export interface ReviewSnapshot {
  sessionId: string;
  state: ReviewStateName;
  nextAction: string;
  approvals: ReviewApproval[];
  changes: ReviewChange[];
  verifications: ReviewVerification[];
  checkpoints: { id: string; label: string; ts: number; auto: boolean; ok: boolean }[];
  lastCheckpoint: { id: string; label: string; ts: number; auto: boolean; ok: boolean } | null;
  todos: { content: string; status: string }[];
  interrupted: boolean;
  updatedAt: number;
}

/** v2: one Time Machine checkpoint for the History strip; restore with `/rewind <id>`. */
export interface UiSnapshotCheckpoint {
  id: string;
  label: string;
  ts: number;
  auto: boolean;
}

export interface UiSnapshot {
  models: { coding: string; lite: string };
  goalCount: number;
  mind: {
    weakSpots: number;
    driveDeviations: number;
    habits: number;
    weak?: MindWeakSpot[];
    drives?: MindDrive[];
    habitNames?: string[];
    ledger?: MindLedger;
  };
  graph: {
    nodeCount: number;
    fileCount: number;
    aiGraphBuilt: boolean;
    modules: { name: string; criticality?: string }[];
    engine: 'codebase-memory' | 'native' | 'none';
  };
  contextWindow: number;
  tokensBaseline: number;
  compressionSaved: number;
  workspace: { count: number; names: string[]; writable: number };
  sessions?: UiSnapshotSession[];
  checkpoints?: UiSnapshotCheckpoint[];
  git?: { branch: string; dirty: number; ahead: number; behind: number };
  tools?: {
    registered: number;
    ready: number;
    deferred: number;
    discovered: number;
    mcp: number;
    graphReady: boolean;
  };
  /**
   * The Composer's document corpus. Mirrors `UiSnapshotComposer` in src/protocol/ui.snapshot.ts.
   *
   * `lastIngest.skipped` is the field that earns its place in the UI: a user who drops 200 reports
   * and sees only "191 ingested" proceeds as though all 200 were read, and the unreadable scans are
   * exactly the ones that change an assessment.
   */
  composer?: {
    session: number;
    library: number;
    passages: number;
    facts: number;
    lastIngest?: {
      ingested: number;
      chunks: number;
      skipped: { name: string; reason: string }[];
    };
  };
}

// Phase 4 moved every Computer Use owner out of the engine, so `ui_snapshot` no longer carries a
// `computer` block and `UiSnapshotComputer` was removed with its last consumer (the old Dock's
// posture card). Mac state now reaches the renderer as the Desktop provider's own typed tool
// receipts — see `mac.session.model.ts`. Re-adding a posture field here would recreate the
// engine-owned CU vocabulary the two-product boundary removed.
