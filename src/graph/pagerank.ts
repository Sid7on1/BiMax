import { IGraphStore, GraphNode, GraphData, GraphEdge } from './models';

export interface PageRankResult {
  nodeId: string;
  label: string;
  type: string;
  score: number;
  filePath?: string;
}

/**
 * PageRank on the code reference graph. High-scoring nodes are symbols that many
 * other nodes depend on — the "load-bearing" identifiers in the codebase.
 *
 * Uses the standard iterative algorithm with damping factor d (default 0.85).
 * Converges in ~30 iterations for typical code graphs (<50k nodes).
 */
// ponytail: PageRank is recomputed on EVERY agent-loop iteration (the repo-map injection), ~150ms
// over a large graph × up to 130 iterations per task = seconds of pure waste — yet the graph only
// changes on /index. So results are memoized per graph.
//
// The key used to be node and edge COUNTS plus the first and last node id, so a re-index that rewired
// edges without changing those counts kept serving the old ranking (record 47, A06). The cache is now
// keyed by the GraphData object itself and checked against the identity and length of its edge array
// and its node count: setGraph, clear, loadFromDisk and removeNode replace the object or the array, and
// addNode/addEdge change a count. Only an edge mutated in place would go unseen. A WeakMap drops
// entries along with their graphs, so a cross-repo workspace that ranks several stores per turn (PR3)
// still hits without a size cap.
interface GraphCacheEntry<T> {
  edges: GraphEdge[];
  edgeCount: number;
  nodeCount: number;
  values: Map<string, T>;
}

/** The cached values for this graph, emptied whenever the graph has changed since they were stored. */
function cacheFor<T>(cache: WeakMap<GraphData, GraphCacheEntry<T>>, graph: GraphData): Map<string, T> {
  const entry = cache.get(graph);
  if (entry && entry.edges === graph.edges && entry.edgeCount === graph.edges.length && entry.nodeCount === graph.nodes.size) {
    return entry.values;
  }
  const fresh: GraphCacheEntry<T> = { edges: graph.edges, edgeCount: graph.edges.length, nodeCount: graph.nodes.size, values: new Map() };
  cache.set(graph, fresh);
  return fresh.values;
}

const _prCache = new WeakMap<GraphData, GraphCacheEntry<Map<string, number>>>();

export function computePageRank(
  store: IGraphStore,
  iterations = 30,
  damping = 0.85,
): Map<string, number> {
  const graph = store.getGraph();
  const nodes = Array.from(graph.nodes.values());
  if (nodes.length === 0) return new Map();

  const cached = cacheFor(_prCache, graph);
  const key = `${iterations}:${damping}`;
  const hit = cached.get(key);
  if (hit) return hit;

  const N = nodes.length;
  const scores = new Map<string, number>();
  for (const n of nodes) scores.set(n.id, 1 / N);

  // Pre-compute out-degree for each node
  const outDegree = new Map<string, number>();
  for (const n of nodes) outDegree.set(n.id, store.getEdgesFrom(n.id).length);

  for (let iter = 0; iter < iterations; iter++) {
    // A node with no outgoing edges hands its rank to every node, the way a random surfer at a dead end
    // jumps anywhere. Skipping it leaked that rank on every iteration, so the scores stopped summing to 1.
    let dangling = 0;
    for (const n of nodes) if (outDegree.get(n.id) === 0) dangling += scores.get(n.id) ?? 0;
    const base = (1 - damping) / N + (damping * dangling) / N;

    const next = new Map<string, number>();
    for (const n of nodes) next.set(n.id, base);

    for (const n of nodes) {
      const outEdges = store.getEdgesFrom(n.id);
      if (outEdges.length === 0) continue;
      const contribution = (scores.get(n.id) ?? 0) * damping / outEdges.length;
      for (const edge of outEdges) {
        next.set(edge.targetId, (next.get(edge.targetId) ?? 0) + contribution);
      }
    }

    for (const [id, s] of next) scores.set(id, s);
  }

  cached.set(key, scores);
  return scores;
}

/**
 * Returns the top-K nodes by PageRank score as a formatted outline string.
 * Filters to FUNCTION and CLASS types since those are what the agent cares about.
 */
export function getTopNodes(store: IGraphStore, k = 15): PageRankResult[] {
  const scores = computePageRank(store);
  const graph = store.getGraph();

  const results: PageRankResult[] = [];
  for (const [id, score] of scores) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (node.type !== 'FUNCTION' && node.type !== 'CLASS' && node.type !== 'FILE') continue;
    results.push({
      nodeId: id,
      label: node.name || id,
      type: node.type,
      score,
      filePath: node.filePath,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

const estTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Build a compact "repo map" for injection into the model's context — the same idea aider proved
 * works on non-caching models: instead of making the agent read whole files to orient itself, give
 * it a PageRank-ranked, token-budgeted outline of the codebase's load-bearing SYMBOLS (their
 * signatures, grouped by file). The model sees the skeleton of the whole repo for a fixed ~1.5k
 * tokens and can navigate straight to what it needs, rather than grepping/reading blindly.
 *
 * Greedy admission by descending PageRank until `maxTokens` is spent; within each file, symbols are
 * ordered by source line so the outline reads top-to-bottom. Falls back to `type name` when a node
 * has no captured signature (older graphs). Empty string when the graph isn't indexed.
 */
const MAP_CACHE_MAX = 8;
const _mapCache = new WeakMap<GraphData, GraphCacheEntry<string>>();

/**
 * `headerLabel` (PR3): override the standalone `[RepoMap] …` header with a compact repo-scoped line
 * when this outline is one SECTION of a larger cross-repo map (see graph/cross.repo.ts). Omit it for
 * the normal single-repo outline — behavior is then unchanged.
 */
export function formatRepoMapOutline(store: IGraphStore, maxTokens = 1500, focusTerms: string[] = [], headerLabel?: string): string {
  const graph = store.getGraph();
  // ponytail: re-injected every loop iteration, but within a task the graph and the focus terms (from
  // the same user message) are stable — cache the rendered outline per graph (keyed by the graph object,
  // for the reason given above computePageRank) and per budget + focus, so we render once per task
  // instead of sorting 19k nodes 130×. At most MAP_CACHE_MAX outlines are kept for one graph.
  const outlines = cacheFor(_mapCache, graph);
  const cacheKey = `${maxTokens}:${focusTerms.join(',')}:${headerLabel || ''}`;
  const hit = outlines.get(cacheKey);
  if (hit !== undefined) return hit;
  const done = (out: string): string => {
    outlines.set(cacheKey, out);
    if (outlines.size > MAP_CACHE_MAX) outlines.delete(outlines.keys().next().value as string);
    return out;
  };

  const scores = computePageRank(store);

  // Personalization (aider's `mentioned_idents`): symbols whose name/file matches a term from the
  // CURRENT request float to the top, so the map is about THIS task — not just globally important
  // code. Two-tier sort: focus matches first (by PageRank), then everything else (by PageRank).
  const focus = focusTerms.map(t => t.toLowerCase()).filter(t => t.length > 2);
  const isFocus = (n: GraphNode): boolean => {
    if (focus.length === 0) return false;
    const hay = (n.name + ' ' + (n.filePath || '')).toLowerCase();
    return focus.some(t => hay.includes(t));
  };

  // Only real top-level definitions — not STATEMENT/VARIABLE/BLOCK nodes, whose "signature" is just
  // a code line (`result = super.emit(...)`) and would fill the map with noise.
  const DEF_TYPES = new Set<GraphNode['type']>(['FUNCTION', 'CLASS', 'INTERFACE']);
  const ranked = Array.from(graph.nodes.values())
    .filter((n: GraphNode) => !!n.filePath && DEF_TYPES.has(n.type))
    .map((n: GraphNode) => ({ n, score: scores.get(n.id) ?? 0, focus: false }))
    .map(e => ({ ...e, focus: isFocus(e.n) }))
    .sort((a, b) => (a.focus !== b.focus ? (a.focus ? -1 : 1) : b.score - a.score));
  if (ranked.length === 0) return done('');

  const header = headerLabel ??
    '[RepoMap] PageRank-ranked outline of the most load-bearing symbols in this repository ' +
    '(signatures only — NOT the full source). Use it to navigate: jump straight to the relevant ' +
    'file/symbol with ReadFileTool (startLine/endLine) or GraphContextTool instead of exploring blindly.';

  // `maxTokens` budgets the SYMBOL outline; the fixed header is overhead on top of it.
  const byFile = new Map<string, { line: number; text: string }[]>();
  const fileOrder: string[] = [];
  let used = 0;

  for (const { n } of ranked) {
    const file = n.filePath!;
    const sig = (n.signature || `${String(n.type).toLowerCase()} ${n.name}`).trim();
    const text = '  ' + sig;
    const isNewFile = !byFile.has(file);
    const cost = estTokens(text) + (isNewFile ? estTokens(file + ':') : 0);
    if (used + cost > maxTokens) break;
    used += cost;
    if (isNewFile) {
      byFile.set(file, []);
      fileOrder.push(file);
    }
    byFile.get(file)!.push({ line: n.startLine ?? 0, text });
  }
  if (byFile.size === 0) return done('');

  const lines = [header];
  for (const file of fileOrder) {
    lines.push('', file + ':');
    for (const s of byFile.get(file)!.sort((a, b) => a.line - b.line)) lines.push(s.text);
  }
  return done(lines.join('\n'));
}
