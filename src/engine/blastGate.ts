import { IGraphStore, GraphNode } from '../graph/models';
import { ImpactEngine } from '../graph/impact.engine';

/**
 * G5 — Blast-radius edit gate. Before an edit lands on a file that owns a HIGH/CRITICAL
 * symbol, compute its blast radius and ask the user to confirm. Mirrors the diffApproval
 * design: the interactive UI registers a confirmer + the graph store; in sub-agent workers
 * and print mode no confirmer is registered, so the gate auto-allows and never hangs.
 * Off by default — toggled via `/governor blast-gate on|off`.
 */
export type BlastConfirmer = (message: string) => Promise<boolean>;

let enabled = false;
let confirmer: BlastConfirmer | null = null;
let store: IGraphStore | null = null;

export function setBlastGateEnabled(value: boolean): void { enabled = value; }
export function isBlastGateEnabled(): boolean { return enabled; }
export function registerBlastConfirmer(fn: BlastConfirmer | null): void { confirmer = fn; }
export function registerBlastGraphStore(s: IGraphStore | null): void { store = s; }

const GATED = new Set(['HIGH', 'CRITICAL']);
function critRank(c?: string): number { return c === 'CRITICAL' ? 2 : c === 'HIGH' ? 1 : 0; }

/**
 * Pure: find the highest-criticality HIGH/CRITICAL symbol living in `absFilePath`, or null
 * if the file owns none. Graph nodes store paths relative to the project root, so we match
 * by suffix against the absolute path the edit tools resolve.
 */
export function findCriticalSymbol(graphStore: IGraphStore, absFilePath: string): GraphNode | null {
  const norm = absFilePath.replace(/\\/g, '/');
  let best: GraphNode | null = null;
  for (const node of graphStore.getGraph().nodes.values()) {
    if (!node.filePath || !GATED.has(node.criticality || '')) continue;
    const rel = node.filePath.replace(/\\/g, '/');
    if (!norm.endsWith(rel)) continue;
    if (!best
      || critRank(node.criticality) > critRank(best.criticality)
      || (critRank(node.criticality) === critRank(best.criticality) && (node.riskScore || 0) > (best.riskScore || 0))) {
      best = node;
    }
  }
  return best;
}

/** Build the human-readable warning for a gated edit (pure; reused by tests). */
export function blastWarning(node: GraphNode, engine: ImpactEngine): string {
  const r = engine.calculateBlastRadius(node.id);
  return [
    `⚠️ This edit touches ${node.name} [${node.criticality}] in ${node.filePath}.`,
    `Blast radius: ${r.totalImpactedNodes} downstream dependent(s) `
      + `(files ${r.impactedFiles}, functions ${r.impactedFunctions}, classes ${r.impactedClasses}).`,
    'Proceed with the edit?',
  ].join('\n');
}

/**
 * Returns true if the edit may proceed. Auto-allows when the gate is off, no confirmer is
 * registered (workers / print mode), no graph store is set, or the file owns no gated
 * symbol. Only an interactive "no" blocks the write.
 */
export async function checkBlastRadius(absFilePath: string): Promise<boolean> {
  if (!enabled || !confirmer || !store) return true;
  const node = findCriticalSymbol(store, absFilePath);
  if (!node) return true;
  try {
    return await confirmer(blastWarning(node, new ImpactEngine(store)));
  } catch {
    return true; // never block the agent on a confirmer failure
  }
}
