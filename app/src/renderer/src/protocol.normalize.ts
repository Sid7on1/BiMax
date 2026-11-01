import type { ReviewSnapshot, ReviewStateName, SubAgentClaim, UiSnapshot } from './protocol';

/**
 * Make hostile, truncated or out-of-date protocol payloads safe at the boundary.
 *
 * `05_TARGET_ARCHITECTURE.md` requires "unknown additive messages ignored; incompatible major
 * versions fail visibly" and golden "malformed-frame fixtures". Before this, a `ui_snapshot` that
 * merely omitted `models` reached the composer as a truthy object and took the whole renderer down
 * with `undefined.coding` — a blank window, which is the worst possible way to report a bad frame.
 *
 * The rule here is narrow: fill in the SHAPE, never the FACTS. A missing model name becomes an
 * empty string the UI renders as "model", not a plausible-looking default; a missing counter
 * becomes 0 and the panel shows its honest empty state.
 */

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const arr = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

export function normalizeUiSnapshot(raw: unknown): UiSnapshot | null {
  if (!isRecord(raw)) return null;
  const models = isRecord(raw.models) ? raw.models : {};
  const mind = isRecord(raw.mind) ? raw.mind : {};
  const graph = isRecord(raw.graph) ? raw.graph : {};
  const engine = graph.engine === 'codebase-memory' || graph.engine === 'native' ? graph.engine : 'none';
  return {
    models: { coding: str(models.coding), lite: str(models.lite) },
    goalCount: num(raw.goalCount),
    mind: {
      weakSpots: num(mind.weakSpots),
      driveDeviations: num(mind.driveDeviations),
      habits: num(mind.habits),
      ...(Array.isArray(mind.weak) ? { weak: mind.weak } : {}),
      ...(Array.isArray(mind.drives) ? { drives: mind.drives } : {}),
      ...(Array.isArray(mind.habitNames) ? { habitNames: mind.habitNames } : {}),
      ...(isRecord(mind.ledger) ? {
        ledger: {
          resolved: num(mind.ledger.resolved),
          open: num(mind.ledger.open),
          expired: num(mind.ledger.expired),
          coveragePct: num(mind.ledger.coveragePct),
          overconfident: num(mind.ledger.overconfident),
        },
      } : {}),
    },
    graph: {
      nodeCount: num(graph.nodeCount),
      fileCount: num(graph.fileCount),
      aiGraphBuilt: graph.aiGraphBuilt === true,
      modules: arr<{ name: string; criticality?: string }>(graph.modules)
        .filter(isRecord).map(module => ({ name: str(module.name), ...(module.criticality ? { criticality: str(module.criticality) } : {}) })),
      engine,
    },
    contextWindow: num(raw.contextWindow),
    tokensBaseline: num(raw.tokensBaseline),
    compressionSaved: num(raw.compressionSaved),
    workspace: isRecord(raw.workspace)
      ? { count: num(raw.workspace.count), names: arr<string>(raw.workspace.names).map(str), writable: num(raw.workspace.writable) }
      : { count: 0, names: [], writable: 0 },
    sessions: arr<Record<string, any>>(raw.sessions).filter(isRecord).map(session => ({
      id: str(session.id),
      title: str(session.title),
      startedAt: str(session.startedAt),
      messageCount: num(session.messageCount),
      cwd: str(session.cwd),
      current: session.current === true,
    })),
    checkpoints: arr<Record<string, any>>(raw.checkpoints).filter(isRecord).map(checkpoint => ({
      id: str(checkpoint.id),
      label: str(checkpoint.label),
      ts: num(checkpoint.ts),
      auto: checkpoint.auto === true,
    })),
    ...(isRecord(raw.git) ? {
      git: {
        branch: str(raw.git.branch), dirty: num(raw.git.dirty),
        ahead: num(raw.git.ahead), behind: num(raw.git.behind),
      },
    } : {}),
    ...(isRecord(raw.tools) ? {
      tools: {
        registered: num(raw.tools.registered), ready: num(raw.tools.ready),
        deferred: num(raw.tools.deferred), discovered: num(raw.tools.discovered),
        mcp: num(raw.tools.mcp), graphReady: raw.tools.graphReady === true,
      },
    } : {}),
    ...(isRecord(raw.approvals)
      && typeof raw.approvals.askBeforeEdits === 'boolean'
      && typeof raw.approvals.readOnly === 'boolean'
      && typeof raw.approvals.unattended === 'boolean' ? {
      approvals: {
        askBeforeEdits: raw.approvals.askBeforeEdits,
        readOnly: raw.approvals.readOnly,
        unattended: raw.approvals.unattended,
      },
    } : {}),
  };
}

const REVIEW_STATES: ReviewStateName[] = [
  'idle', 'planning', 'awaiting_approval', 'applying',
  'unverified', 'verification_failed', 'verified', 'checkpointed',
];

export function normalizeReviewSnapshot(raw: unknown): ReviewSnapshot | null {
  if (!isRecord(raw)) return null;
  // An unrecognised state from a newer engine must not be shown as a green one. `idle` is the
  // only state that claims nothing.
  const state = REVIEW_STATES.includes(raw.state as ReviewStateName) ? raw.state as ReviewStateName : 'idle';
  return {
    sessionId: str(raw.sessionId),
    state,
    nextAction: str(raw.nextAction),
    approvals: arr<Record<string, any>>(raw.approvals).filter(isRecord).map(approval => ({
      id: num(approval.id),
      kind: approval.kind === 'diff' || approval.kind === 'question' ? approval.kind : 'permission',
      question: str(approval.question),
      requestedAt: num(approval.requestedAt),
      ...(isRecord(approval.resolution) ? {
        resolution: {
          value: str(approval.resolution.value),
          approved: approval.resolution.approved === true,
          at: num(approval.resolution.at),
          ...(approval.resolution.interrupted === true ? { interrupted: true } : {}),
        },
      } : {}),
    })),
    changes: arr<Record<string, any>>(raw.changes).filter(isRecord).map(change => ({
      file: str(change.file),
      tools: arr<string>(change.tools).map(str),
      edits: num(change.edits),
      ...(change.lastCallId ? { lastCallId: str(change.lastCallId) } : {}),
      lastAt: num(change.lastAt),
    })),
    verifications: arr<Record<string, any>>(raw.verifications).filter(isRecord).map(check => ({
      command: str(check.command),
      // A verification whose result was not stated is NOT a pass.
      ok: check.ok === true,
      settled: num(check.settled),
      coveredFiles: arr<string>(check.coveredFiles).map(str),
      repoWide: check.repoWide === true,
      at: num(check.at),
    })),
    checkpoints: arr<Record<string, any>>(raw.checkpoints).filter(isRecord).map(checkpoint => ({
      id: str(checkpoint.id), label: str(checkpoint.label), ts: num(checkpoint.ts),
      auto: checkpoint.auto === true, ok: checkpoint.ok === true,
    })),
    lastCheckpoint: isRecord(raw.lastCheckpoint) ? {
      id: str(raw.lastCheckpoint.id), label: str(raw.lastCheckpoint.label),
      ts: num(raw.lastCheckpoint.ts), auto: raw.lastCheckpoint.auto === true,
      ok: raw.lastCheckpoint.ok === true,
    } : null,
    todos: arr<Record<string, any>>(raw.todos).filter(isRecord)
      .map(todo => ({ content: str(todo.content), status: str(todo.status) })),
    interrupted: raw.interrupted === true,
    updatedAt: num(raw.updatedAt),
  };
}

export function normalizeSubAgents(raw: unknown): SubAgentClaim[] {
  return arr<Record<string, any>>(raw).filter(isRecord).map(agent => ({
    taskId: str(agent.taskId),
    agentType: str(agent.agentType) || 'specialist',
    scope: str(agent.scope) || '(unscoped)',
    prompt: str(agent.prompt),
    status: agent.status === 'done' || agent.status === 'failed' ? agent.status : 'running',
    startedAt: num(agent.startedAt),
    toolCalls: num(agent.toolCalls),
    ...(agent.endedAt !== undefined ? { endedAt: num(agent.endedAt) } : {}),
    ...(agent.result ? { result: str(agent.result) } : {}),
    ...(agent.error ? { error: str(agent.error) } : {}),
  }));
}

export function normalizeTodos(raw: unknown): { content?: string; status?: string }[] {
  return arr<Record<string, any>>(raw).filter(isRecord)
    .map(todo => ({ content: str(todo.content), status: str(todo.status) }));
}
