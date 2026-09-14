import { IGraphStore, GraphNode } from './models';
import { ImpactEngine } from './impact.engine';
import { resolveNodeId } from './node.search';
import { readSymbolSource } from './symbol.source';

// G3 — Graph-Guided Context Pack.
// Instead of dumping a whole file into the LLM, assemble the *minimal* context needed to
// safely edit a symbol: the target symbol's full body, plus the SIGNATURES ONLY of its
// direct callers (reverse deps) and callees/types (forward deps). Token-budgeted and
// ranked by criticality so the most important neighbors survive truncation.

const CHARS_PER_TOKEN = 4; // Rough, model-agnostic estimate — good enough for budgeting.
const CRIT_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface ContextPackEntry {
  nodeId: string;
  role: 'target' | 'caller' | 'callee';
  text: string; // full body for the target; a single signature line for neighbors
}

export interface ContextPack {
  targetId: string;
  entries: ContextPackEntry[];
  text: string;        // assembled, ready to inject into the prompt
  tokenEstimate: number;
  truncated: boolean;  // true if anything was cut to fit the budget: neighbor signatures or the target body
}

export interface PlanContextOptions {
  cwd: string;
  maxTokens?: number; // hard cap on the assembled pack (default 1500)
  depth?: number;     // neighbor traversal depth (default 2 — see note below)
}

// Default traversal depth is 2, not 1: the static analyzer attaches CALLS/USES edges to the
// function's inner *block* node (func --CONTAINS--> block --CALLS--> callee), so the real
// neighbor sits one structural hop past the target. Depth 2 crosses that block layer;
// non-symbol intermediaries (blocks/statements/vars) are dropped by `isSymbol`.
const DEFAULT_DEPTH = 2;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A node is "code we can show source/signature for" if it is a class/function/method/iface. */
function isSymbol(n: GraphNode): boolean {
  return n.type === 'FUNCTION' || n.type === 'CLASS' || n.type === 'INTERFACE';
}

function critRank(n: GraphNode): number {
  return CRIT_RANK[n.criticality || ''] || 0;
}

async function readBody(node: GraphNode, cwd: string): Promise<string | null> {
  const { text } = await readSymbolSource(node, cwd);
  return text ?? null;
}

/** A neighbor's one-line signature for the pack (falls back to the symbol name). */
function signatureLine(n: GraphNode): string {
  const sig = n.signature || n.name;
  const where = n.filePath ? ` (${n.filePath}${n.startLine != null ? `:${n.startLine}` : ''})` : '';
  const crit = n.criticality ? ` [${n.criticality}]` : '';
  return `${sig}${where}${crit}`;
}

/**
 * Assemble a minimal, token-budgeted context pack for editing `target` (a node id or
 * keyword). Returns `{ error }` if the target can't be uniquely resolved.
 */
export async function planContext(
  store: IGraphStore,
  target: string,
  opts: PlanContextOptions
): Promise<ContextPack | { error: string }> {
  const maxTokens = opts.maxTokens ?? 1500;
  const depth = opts.depth ?? DEFAULT_DEPTH;

  const resolved = resolveNodeId(store, target);
  if (resolved.ambiguous) {
    return { error: `"${target}" is ambiguous (${resolved.ambiguous.length} candidates). Be more specific.` };
  }
  if (!resolved.id) return { error: `No node found for "${target}".` };

  const targetNode = store.getNode(resolved.id)!;
  const engine = new ImpactEngine(store);

  // Structural parents (the file/class that CONTAINS the target) show up in the reverse
  // traversal but are not "callers" — exclude them so the callers list is real dependents.
  const structuralParents = new Set(
    store.getEdgesTo(resolved.id).filter(e => e.type === 'CONTAINS').map(e => e.sourceId)
  );

  // Direct callers (who depends on this) and callees/types (what this uses).
  const callers = engine.getReverseDependencies(resolved.id, depth)
    .filter(isSymbol)
    .filter(n => !structuralParents.has(n.id));
  const callees = engine.getForwardDependencies(resolved.id, depth).filter(isSymbol);

  // Build the target entry first — it is always included (the whole point of the pack).
  const body = await readBody(targetNode, opts.cwd);
  const targetText = body
    ?? `${targetNode.signature || targetNode.name} (source unavailable — re-run /index)`;
  const entries: ContextPackEntry[] = [
    { nodeId: targetNode.id, role: 'target', text: targetText },
  ];

  // Rank neighbors: highest criticality first, deduped, excluding the target itself.
  const seen = new Set<string>([targetNode.id]);
  const rankNeighbor = (n: GraphNode) => !seen.has(n.id) && seen.add(n.id);
  const rankedCallers = callers.filter(rankNeighbor).sort((a, b) => critRank(b) - critRank(a));
  const rankedCallees = callees.filter(rankNeighbor).sort((a, b) => critRank(b) - critRank(a));

  // Every budget check below measures the RENDERED pack, headers and notes included. Counting only
  // entry texts let a 100-token pack come back at ~1,800 tokens marked not truncated (record 47, A05):
  // the target body went in whole, and the headers were never counted.
  const packTokens = (candidate: ContextPackEntry[], neighborsOmitted: boolean, bodyCut: boolean) =>
    estimateTokens(renderPack(targetNode, candidate, neighborsOmitted, bodyCut));
  const hasNeighbors = rankedCallers.length + rankedCallees.length > 0;

  // The target comes first. If its whole body cannot fit, keep the leading lines that do and say where
  // the rest is; if not even the headers fit, say so rather than return an oversized pack.
  let bodyCut = false;
  if (packTokens(entries, hasNeighbors, false) > maxTokens) {
    const cut = cutBody(targetNode, targetText, maxTokens, (text) =>
      packTokens([{ ...entries[0], text }], hasNeighbors, true));
    if (cut === null) {
      const floor = packTokens([{ ...entries[0], text: bodyNote(targetNode, maxTokens, 0, 1) }], hasNeighbors, true);
      return { error: `The context pack for "${targetNode.name}" cannot fit in ${maxTokens} tokens: its headers alone need about ${floor}. Raise maxTokens.` };
    }
    entries[0] = { ...entries[0], text: cut };
    bodyCut = true;
  }

  // Fill what is left with neighbor signatures (callers before callees). Each is checked as if the
  // omission note were already there, so adding the note afterwards cannot break the budget.
  let neighborsOmitted = bodyCut && hasNeighbors;
  const addNeighbors = (nodes: GraphNode[], role: 'caller' | 'callee') => {
    for (const n of nodes) {
      entries.push({ nodeId: n.id, role, text: signatureLine(n) });
      if (packTokens(entries, true, bodyCut) > maxTokens) {
        entries.pop();
        neighborsOmitted = true;
      }
    }
  };
  if (!bodyCut) {
    addNeighbors(rankedCallers, 'caller');
    addNeighbors(rankedCallees, 'callee');
  }

  const text = renderPack(targetNode, entries, neighborsOmitted, bodyCut);
  return { targetId: targetNode.id, entries, text, tokenEstimate: estimateTokens(text), truncated: neighborsOmitted || bodyCut };
}

/**
 * The longest leading slice of `body`, ending in a note that says where the rest is, whose pack still
 * fits. Null when not even the note fits. `measure` renders the candidate pack and counts its tokens.
 */
function cutBody(node: GraphNode, body: string, maxTokens: number, measure: (text: string) => number): string | null {
  const lines = body.split('\n');
  const candidate = (kept: number) => [...lines.slice(0, kept), bodyNote(node, maxTokens, kept, lines.length)].join('\n');
  if (measure(candidate(0)) > maxTokens) return null;
  // Keeping every line is the whole body, which did not fit, so search 0..lines-1.
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(candidate(mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return candidate(lo);
}

/** The last line of a cut target body: how much was left out, and where to read it. */
function bodyNote(node: GraphNode, maxTokens: number, kept: number, total: number): string {
  const exact = !!node.filePath && node.startLine != null && node.endLine != null
    && node.endLine - node.startLine + 1 === total;
  const where = exact
    ? `read ${node.filePath} lines ${node.startLine! + kept}-${node.endLine} for the rest`
    : `read the full source of ${node.name} for the rest`;
  return `// … ${total - kept} of ${total} lines omitted to fit the ${maxTokens}-token budget — ${where}`;
}

function renderPack(targetNode: GraphNode, entries: ContextPackEntry[], neighborsOmitted: boolean, bodyCut: boolean): string {
  const out: string[] = [];
  const targetEntry = entries.find(e => e.role === 'target')!;
  const crit = targetNode.criticality ? ` [${targetNode.criticality}${targetNode.riskScore != null ? ` risk=${targetNode.riskScore}` : ''}]` : '';
  const loc = targetNode.filePath
    ? `${targetNode.filePath}${targetNode.startLine != null ? `:${targetNode.startLine}-${targetNode.endLine}` : ''}`
    : '(location unknown)';

  out.push(`===== CONTEXT PACK: ${targetNode.type} ${targetNode.name}${crit} =====`);
  out.push(`// ${loc}`);
  out.push('');
  out.push(bodyCut ? '--- TARGET (source cut to fit the token budget) ---' : '--- TARGET (full source) ---');
  out.push(targetEntry.text);

  const callers = entries.filter(e => e.role === 'caller');
  if (callers.length) {
    out.push('');
    out.push('--- CALLERS (depend on this — update if you change its signature) ---');
    for (const c of callers) out.push(`// ${c.text}`);
  }

  const callees = entries.filter(e => e.role === 'callee');
  if (callees.length) {
    out.push('');
    out.push('--- CALLEES / TYPES (used by this) ---');
    for (const c of callees) out.push(`// ${c.text}`);
  }

  if (neighborsOmitted) {
    out.push('');
    out.push('// (some neighbors omitted to fit the token budget — query GraphQueryTool for more)');
  }
  return out.join('\n');
}
