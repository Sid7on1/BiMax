// Sub-agent coordination blackboard (parent-side). Sub-agents run isolated (thread or subprocess) and
// share nothing at runtime by design — so coordination lives HERE, in the orchestrator: every spawn
// records the SCOPE it covers, siblings' scopes are checked for overlap before spawning, and each
// agent's live status (running/done/failed + tool count + result) is tracked for the /subagents view
// and the TUI panel. This is what turns "fire N blind agents and hope they don't collide" into a
// coordinated map→reduce.

export type SubAgentStatus = 'running' | 'done' | 'failed';
export type SubAgentPhase = 'booting' | 'working' | 'researching' | 'editing' | 'testing' | 'done' | 'failed';

export interface SubAgentClaim {
  taskId: string;
  outcomeTaskId?: string;
  agentType: string;
  scope: string;            // what this agent is responsible for (paths/globs/topic) — the claim
  prompt: string;           // first line of the task, for display
  status: SubAgentStatus;
  phase: SubAgentPhase;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;        // live count of tool activity relayed from the agent
  result?: string;
  error?: string;
}

/** Split a scope string into normalized path/topic tokens for overlap comparison. */
function tokens(scope: string): string[] {
  return (scope || '')
    .split(/[\s,;]+/)
    .map(s => s.trim().replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/** Two scopes overlap if any token of one is a path-prefix of a token of the other (or equal). */
export function scopesOverlap(a: string, b: string): boolean {
  const ta = tokens(a), tb = tokens(b);
  for (const x of ta) {
    for (const y of tb) {
      if (x === y) return true;
      if (x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
    }
  }
  return false;
}

export class SubAgentBlackboard {
  private claims = new Map<string, SubAgentClaim>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* observers cannot break worker completion */ }
    }
  }

  register(taskId: string, agentType: string, scope: string, prompt: string, outcomeTaskId?: string): void {
    this.claims.set(taskId, {
      taskId, outcomeTaskId, agentType, scope: scope || '(unscoped)',
      prompt: (prompt || '').split('\n')[0].slice(0, 120),
      status: 'running', phase: 'booting', startedAt: Date.now(), toolCalls: 0,
    });
  }

  setPhase(taskId: string, phase: SubAgentPhase): void {
    const claim = this.claims.get(taskId);
    if (claim && claim.status === 'running') claim.phase = phase;
  }

  incTool(taskId: string): void {
    const c = this.claims.get(taskId);
    if (c) c.toolCalls++;
  }

  markDone(taskId: string, result: string): void {
    const c = this.claims.get(taskId);
    if (c) { c.status = 'done'; c.phase = 'done'; c.endedAt = Date.now(); c.result = result; this.changed(); }
  }

  markFailed(taskId: string, error: string): void {
    const c = this.claims.get(taskId);
    if (c) { c.status = 'failed'; c.phase = 'failed'; c.endedAt = Date.now(); c.error = error; this.changed(); }
  }

  /** Running claims whose scope overlaps the candidate — the sibling collisions to avoid. */
  overlapping(scope: string): SubAgentClaim[] {
    if (!scope) return [];
    return this.active().filter(c => scopesOverlap(c.scope, scope));
  }

  active(): SubAgentClaim[] {
    return [...this.claims.values()].filter(c => c.status === 'running');
  }

  all(): SubAgentClaim[] {
    return [...this.claims.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Drop finished claims older than the cutoff so the board doesn't grow unbounded. */
  prune(maxAgeMs = 5 * 60_000): void {
    const now = Date.now();
    for (const [id, c] of this.claims) {
      if (c.status !== 'running' && c.endedAt && now - c.endedAt > maxAgeMs) this.claims.delete(id);
    }
  }

  clear(): void { this.claims.clear(); this.changed(); }
}

export const globalSubAgentBlackboard = new SubAgentBlackboard();
