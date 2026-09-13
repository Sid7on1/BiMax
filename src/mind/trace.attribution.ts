/** Trace outcomes are observations, never reconstructed LLM recordings or causal blame. */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  status: string;
}

export interface AttributedOperation {
  spanId: string;
  agentSpanId: string | null;
  operation: string;
  execution: 'ok' | 'error' | 'unknown';
  attribution: 'scoped-verification' | 'unattributed';
  reason: string;
  confidence: number | null;
  claim: 'verified' | 'refuted' | 'expired' | 'open' | null;
  evidenceSpanId: string | null;
  /** Failure of a scoped check is not proof that this mutation introduced the defect. */
  causalBlame: null;
}

export interface TraceEpisode {
  version: 1;
  kind: 'trace-outcomes';
  traceId: string;
  replayable: false;
  operations: AttributedOperation[];
}

export const operationOf = (s: TraceSpan): string => String(s.attributes['gen_ai.operation.name'] ?? s.name);
const ms = (n: string): number => Number(BigInt(n) / 1_000_000n);

/**
 * Exact, complete ancestry identifies containment only. Missing parents, cycles, and
 * spans outside their parent's interval invalidate the join. Nested agents are isolated.
 */
function owner(s: TraceSpan, index: Map<string, TraceSpan>): string | null {
  let current = s;
  const visited = new Set<string>();
  let agent: string | null = null;
  while (true) {
    if (visited.has(current.spanId)) return null;
    visited.add(current.spanId);
    if (agent === null && operationOf(current) === 'invoke_agent') agent = current.spanId;
    if (!current.parentSpanId) return agent;
    const parent = index.get(current.parentSpanId);
    if (!parent || BigInt(parent.startTimeUnixNano) > BigInt(current.startTimeUnixNano)
      || BigInt(parent.endTimeUnixNano) < BigInt(current.endTimeUnixNano)) return null;
    current = parent;
  }
}

/**
 * New optional producer contract (NOT present in the historical corpus):
 * bimax.claim.file is a canonical repo-relative path; bimax.evidence.files is an
 * explicit array of verified paths; bimax.evidence.ok is a boolean from a completed
 * verifier. No command-name, basename, green-status, or parent-failure inference.
 * A single preceding mutation of that exact path in the same agent is required.
 * Multiple edits before a check remain ambiguous. Refutation denotes a failed
 * postcondition, not attribution of a regression to a particular edit.
 */
export function attributeTrace(spans: TraceSpan[], asOfMs: number, claimTtlMs: number): TraceEpisode {
  if (!spans.length) throw new Error('empty trace');
  const index = new Map(spans.map(s => [s.spanId, s]));
  if (index.size !== spans.length || spans.some(s => s.traceId !== spans[0].traceId)) throw new Error('conflicting span identity');
  const owners = new Map(spans.map(s => [s.spanId, owner(s, index)]));
  const canonical = (v: unknown): v is string => typeof v === 'string' && v.length > 0
    && !v.startsWith('/') && !v.includes('\\') && !v.split('/').some(p => p === '..' || p === '.' || p === '');
  const operations = spans.map((s): AttributedOperation => {
    const raw = s.attributes['bimax.claim.confidence'];
    const confidence = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
    const agent = owners.get(s.spanId) ?? null;
    const row: AttributedOperation = {
      spanId: s.spanId, agentSpanId: agent, operation: operationOf(s),
      execution: s.status === 'ok' || s.status === 'error' ? s.status : 'unknown',
      attribution: 'unattributed', reason: agent ? 'no-verifiable-claim' : 'incomplete-agent-ancestry',
      confidence, claim: confidence === null ? null : asOfMs - ms(s.endTimeUnixNano) > claimTtlMs ? 'expired' : 'open',
      evidenceSpanId: null, causalBlame: null,
    };
    if (confidence === null || !agent) return row;
    if (operationOf(s) !== 'execute_tool' || s.status !== 'ok') { row.reason = 'invalid-claim-execution'; return row; }
    const file = s.attributes['bimax.claim.file'];
    if (!canonical(file)) { row.reason = 'missing-canonical-claim-file'; return row; }
    row.reason = 'no-scoped-verification';
    for (const e of [...spans].sort((a, b) => ms(a.startTimeUnixNano) - ms(b.startTimeUnixNano))) {
      const files = e.attributes['bimax.evidence.files'];
      const ok = e.attributes['bimax.evidence.ok'];
      if (!Array.isArray(files) || !files.every(canonical) || !files.includes(file) || typeof ok !== 'boolean'
        || owners.get(e.spanId) !== agent || e.spanId === s.spanId
        || BigInt(e.startTimeUnixNano) < BigInt(s.endTimeUnixNano)
        || ms(e.endTimeUnixNano) > asOfMs || ms(e.endTimeUnixNano) - ms(s.endTimeUnixNano) > claimTtlMs) continue;
      const candidates = spans.filter(c => owners.get(c.spanId) === agent && c.attributes['bimax.claim.file'] === file
        && BigInt(c.startTimeUnixNano) <= BigInt(e.endTimeUnixNano));
      if (candidates.length !== 1) { row.reason = 'ambiguous-mutations'; continue; }
      row.claim = ok ? 'verified' : 'refuted';
      row.attribution = 'scoped-verification';
      row.reason = 'explicit-exact-file-postcondition-not-regression-blame';
      row.evidenceSpanId = e.spanId;
      break;
    }
    return row;
  });
  return { version: 1, kind: 'trace-outcomes', traceId: spans[0].traceId, replayable: false, operations };
}
