import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { IGraphStore } from './models';
import { createGraphStore } from './sqlite.graph.store';
import { formatRepoMapOutline } from './pagerank';
import { tryGetWorkspace } from '../core/workspace.manager';

/**
 * Cross-repo context packing (UPGRADE PR3). A multi-repo workspace (workspace.manager.ts) can hold
 * several registered repos; this layer lets the graph tools + the RepoMap injection see ALL of them,
 * each as its own namespace, without merging their graphs:
 *
 *   - Each registered repo keeps its OWN on-disk index (.breakglass/graph/graph.db). We load the
 *     secondary ones lazily and CACHE them for the session (loadFromDisk is expensive; indexes
 *     rarely change mid-session).
 *   - Cross-repo RepoMap: the aider-style PageRank outline (pagerank.ts) is run per repo and merged,
 *     the primary getting the lion's share of the token budget, all personalized by the SAME focus
 *     terms so symbols matching the current task float up within each repo.
 *   - A `repo:<name>` qualifier scopes a GraphContext/GraphQuery call to one repo's store.
 *
 * Deliberately additive: with no multi-repo workspace, everything collapses to the single-repo
 * behavior that existed before (the primary store, unchanged).
 */

export interface RepoStore {
  name: string;
  root: string;
  primary: boolean;
  store: IGraphStore;
}

// Session cache of loaded SECONDARY stores, keyed by repo root. `null` = checked, no usable index
// (so we don't retry the disk every turn). The primary store is always passed in live, never cached.
const _secondaryCache = new Map<string, IGraphStore | null>();
// Roots we've kicked off an async load for, so the sync path triggers each load at most once.
const _warming = new Set<string>();

/** Reset the session cache — test seam / used when the workspace set changes materially. */
export function resetCrossRepoCache(): void { _secondaryCache.clear(); _warming.clear(); }

/** True when a repo already has a graph index on disk — the gate that stops us CREATING one in a
 *  read-only reference repo (the store constructor would otherwise mkdir+create the db file). */
function indexExists(root: string): boolean {
  try {
    const dir = path.join(stateDir('.breakglass', root), 'graph');
    return fs.existsSync(path.join(dir, 'graph.db')) || fs.existsSync(path.join(dir, 'playground.json'));
  } catch { return false; }
}

/** Load one secondary repo's store from disk (cached). Returns null if it has no usable index. */
async function loadSecondary(root: string): Promise<IGraphStore | null> {
  if (_secondaryCache.has(root)) return _secondaryCache.get(root)!;
  let store: IGraphStore | null = null;
  try {
    if (indexExists(root)) {
      const s = createGraphStore(root);
      await s.loadFromDisk();
      if (s.getGraph().nodes.size > 0) store = s;
    }
  } catch { store = null; }
  _secondaryCache.set(root, store);
  return store;
}

/** The primary repo's {name, root} from the workspace, or a synthetic fallback when uninitialized. */
function primaryInfo(): { name: string; root: string } {
  const ws = tryGetWorkspace();
  const root = ws?.primaryPath() ?? process.cwd();
  const name = ws?.active().find(r => path.resolve(r.path) === path.resolve(root))?.name ?? path.basename(root);
  return { name, root };
}

/** The registered SECONDARY repos (everything active except the primary). */
function secondaryRepos(): { name: string; root: string }[] {
  const ws = tryGetWorkspace();
  if (!ws) return [];
  const primaryRoot = path.resolve(ws.primaryPath());
  return ws.active()
    .filter(r => path.resolve(r.path) !== primaryRoot)
    .map(r => ({ name: r.name, root: r.path }));
}

/**
 * Full repo-store set, AWAITING secondary loads — for the graph tools, where a `repo:` qualifier
 * must resolve even on first use (tool.execute is async).
 */
export async function resolveRepoStores(primaryStore: IGraphStore): Promise<RepoStore[]> {
  const { name, root } = primaryInfo();
  const out: RepoStore[] = [{ name, root, primary: true, store: primaryStore }];
  for (const r of secondaryRepos()) {
    const s = await loadSecondary(r.root);
    if (s) out.push({ name: r.name, root: r.root, primary: false, store: s });
  }
  return out;
}

/**
 * Full repo-store set using ONLY already-cached secondaries — for the hot RepoMap injection path,
 * which must stay synchronous and never block compaction on disk I/O. Uncached secondaries are
 * warmed in the background so they appear on a later turn.
 */
export function resolveRepoStoresSync(primaryStore: IGraphStore): RepoStore[] {
  const { name, root } = primaryInfo();
  const out: RepoStore[] = [{ name, root, primary: true, store: primaryStore }];
  for (const r of secondaryRepos()) {
    if (_secondaryCache.has(r.root)) {
      const s = _secondaryCache.get(r.root);
      if (s) out.push({ name: r.name, root: r.root, primary: false, store: s });
    } else if (!_warming.has(r.root)) {
      _warming.add(r.root);
      void loadSecondary(r.root).finally(() => _warming.delete(r.root)); // background warm for next turn
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Split a leading `repo:<name>` qualifier off a graph query. `repo` is undefined when absent. */
export function parseRepoQualifier(query: string): { repo?: string; rest: string } {
  const m = /^\s*repo:(\S+)\s*([\s\S]*)$/i.exec(query || '');
  if (!m) return { rest: (query || '').trim() };
  return { repo: m[1], rest: m[2].trim() };
}

/** Resolve a repo name to its store: exact normalized match first, then a fuzzy contains. */
export function pickRepoStore(repos: RepoStore[], name: string): RepoStore | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return repos.find(r => norm(r.name) === n)
    || repos.find(r => norm(r.name).includes(n) || n.includes(norm(r.name)));
}

/**
 * Merge the given repo stores into ONE cross-repo RepoMap. Pure over its inputs (testable): the
 * primary gets ~60% of the budget, secondaries split the rest (≥300 each), all ranked with the same
 * focus terms. One indexed repo → the plain single-repo outline (byte-identical to before). Always
 * starts with `[RepoMap]` so context.manager's strip-by-prefix keeps exactly one copy in history.
 */
export function composeCrossRepoMap(repos: RepoStore[], maxTokens: number, focusTerms: string[]): string {
  const indexed = repos.filter(r => r.store.getGraph().nodes.size > 0);
  if (indexed.length === 0) return '';
  if (indexed.length === 1) return formatRepoMapOutline(indexed[0].store, maxTokens, focusTerms);

  const primary = indexed.find(r => r.primary) ?? indexed[0];
  const secondaries = indexed.filter(r => r !== primary);
  const primaryBudget = Math.max(600, Math.floor(maxTokens * 0.6));
  const perSecondary = Math.max(300, Math.floor((maxTokens - primaryBudget) / secondaries.length));

  const primaryLabel =
    `[RepoMap] Cross-repo outline — ${indexed.length} indexed repos in this workspace. PageRank-ranked ` +
    `signatures (not full source); to pull a symbol from another repo, use GraphContextTool with a ` +
    `\`repo:<name>\` qualifier. PRIMARY repo "${primary.name}":`;

  const sections = [formatRepoMapOutline(primary.store, primaryBudget, focusTerms, primaryLabel)];
  for (const r of secondaries) {
    const body = formatRepoMapOutline(
      r.store, perSecondary, focusTerms,
      `----- repo: ${r.name} (read-only reference at ${r.root}) — query with repo:${r.name} -----`,
    );
    if (body) sections.push(body);
  }
  return sections.filter(Boolean).join('\n\n');
}

/** The synchronous cross-repo RepoMap for the injection path (cached secondaries only). */
export function crossRepoMapSync(primaryStore: IGraphStore, maxTokens: number, focusTerms: string[]): string {
  return composeCrossRepoMap(resolveRepoStoresSync(primaryStore), maxTokens, focusTerms);
}
