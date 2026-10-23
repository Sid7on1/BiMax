import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Test-Dependency Map (v2 §3.4) — the bipartite "which checks verify which files" graph
 * that turns evidence attribution from a path-string heuristic into stated, tiered
 * weights. Three sources of decreasing confidence, exactly as the plan orders them:
 *
 *   1. coverage (w=1.0) — when the agent runs a PATH-SCOPED coverage check
 *      (`jest src/x.test.ts --coverage`), istanbul's coverage-final.json lists precisely
 *      the source files that test executed. Ingested opportunistically and persisted to
 *      `.bimax/tdm.json`, so the map grows as real coverage runs happen. (Repo-wide
 *      coverage runs are NOT ingested per-test — aggregate coverage can't attribute.)
 *   2. related (w=0.7) — test-file naming conventions: `x.test.ts`/`x.spec.ts`/
 *      `__tests__/x.test.ts` ↔ `x.ts`, `x_test.go` ↔ `x.go`, `test_x.py` ↔ `x.py`.
 *      The same convention tier the mutation engine's candidate discovery trusts.
 *   3. import (w=0.3) — the check file transitively IMPORTS the claim file within a few
 *      hops of the code graph (injected as a predicate so this module stays dependency-free).
 *
 * Consumers ask one question: "how strongly does evidence from THIS check path cover
 * THAT source file?" — and get a weight with its source tier, or null (0 otherwise:
 * unrelated checks no longer touch a claim).
 */

export type CoverSource = 'coverage' | 'related' | 'import';
export interface CoverHit { weight: number; source: CoverSource }

export const TDM_WEIGHTS: Record<CoverSource, number> = { coverage: 1.0, related: 0.7, import: 0.3 };

const COVERAGE_FRESH_MS = 10 * 60_000; // a stale coverage file describes some OTHER run
const IMPORT_MAX_HOPS = 3;

function norm(p: string): string {
  return (p || '').replace(/\\/g, '/');
}

/** Is this path a test file by convention (any of the ecosystems BiMax indexes)? */
export function isTestPath(p: string): boolean {
  const n = norm(p);
  return /(\.test\.|\.spec\.|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/)__tests__\/)/.test(n);
}

/** The source-file stem a test file verifies by naming convention, or null. */
export function testStem(testPath: string): string | null {
  const base = path.basename(norm(testPath));
  let m = base.match(/^(.+?)\.(test|spec)\.[a-z]+$/i);
  if (m) return m[1];
  m = base.match(/^(.+?)_test\.(go|py|rb)$/i);
  if (m) return m[1];
  m = base.match(/^test_(.+?)\.py$/i);
  if (m) return m[1];
  return null;
}

/** Convention tier: does this test file verify this source file by name? */
export function relatedByConvention(testPath: string, sourceFile: string): boolean {
  const stem = testStem(testPath);
  if (!stem) return false;
  const srcBase = path.basename(norm(sourceFile));
  return srcBase.replace(/\.[a-z]+$/i, '') === stem && !isTestPath(sourceFile);
}

/**
 * Import tier over the code graph: BFS the IMPORTS edges from the check file's node,
 * looking for the claim file within a few hops. Kept generic over the store shape so
 * the substrate has no dependency on src/graph.
 */
export function importReachable(
  store: {
    getGraph(): { nodes: Map<string, { id: string; filePath?: string }> };
    getEdgesFrom(id: string): { targetId: string; type: string }[];
  },
  fromPath: string,
  toPath: string,
  maxHops = IMPORT_MAX_HOPS
): boolean {
  const from = norm(fromPath);
  const to = norm(toPath);
  const nodes = store.getGraph().nodes;
  const pathOf = (id: string): string => {
    const n = nodes.get(id);
    return norm(n?.filePath || n?.id || id);
  };
  const start: string[] = [];
  for (const [id, n] of nodes) {
    const p = norm(n.filePath || id);
    if (p.endsWith(from) || from.endsWith(p)) start.push(id);
  }
  if (start.length === 0) return false;

  const seen = new Set(start);
  let frontier = start;
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of store.getEdgesFrom(id)) {
        if (e.type !== 'IMPORTS' && e.type !== 'CONTAINS') continue;
        if (seen.has(e.targetId)) continue;
        seen.add(e.targetId);
        const p = pathOf(e.targetId);
        if (e.type === 'IMPORTS' && (p.endsWith(to) || to.endsWith(p))) return true;
        next.push(e.targetId);
        if (seen.size > 2000) return false; // bounded — the TDM must never become the slow path
      }
    }
    frontier = next;
  }
  return false;
}

interface TdmFile {
  version: 1;
  /** testPath (normalized) → source paths that a scoped coverage run proved it executes. */
  coverage: Record<string, string[]>;
}

export class TestDependencyMap {
  private data: TdmFile = { version: 1, coverage: {} };
  private loaded = false;
  private filePath: string;

  constructor(private projectRoot: string = process.cwd()) {
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'tdm.json');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed?.coverage) this.data = { version: 1, coverage: parsed.coverage };
    } catch { /* first run */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  /**
   * Opportunistic coverage ingestion: called with every evidence command; a no-op unless
   * the command was a PATH-SCOPED coverage run and a fresh coverage-final.json exists.
   * Returns the number of test→file mappings learned.
   */
  ingestCoverageRun(command: string): number {
    const c = command || '';
    if (!/--coverage\b/.test(c) || /--coverage[= ]false/.test(c)) return 0;
    const testPaths = c.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, '')).filter(isTestPath);
    if (testPaths.length === 0) return 0; // aggregate suite coverage can't attribute per-check

    const covFile = path.join(this.projectRoot, 'coverage', 'coverage-final.json');
    let sources: string[];
    try {
      const st = fs.statSync(covFile);
      if (Date.now() - st.mtimeMs > COVERAGE_FRESH_MS) return 0;
      const parsed = JSON.parse(fs.readFileSync(covFile, 'utf-8'));
      sources = Object.keys(parsed)
        .map(k => norm(path.isAbsolute(k) ? path.relative(this.projectRoot, k) : k))
        .filter(p => p && !p.startsWith('..') && !isTestPath(p));
    } catch { return 0; }
    if (sources.length === 0) return 0;

    this.load();
    let learned = 0;
    for (const t of testPaths) {
      const key = norm(t);
      const existing = new Set(this.data.coverage[key] || []);
      for (const s of sources) {
        if (!existing.has(s)) { existing.add(s); learned++; }
      }
      this.data.coverage[key] = Array.from(existing);
    }
    if (learned > 0) this.save();
    return learned;
  }

  /**
   * The TDM question: with what weight does evidence from `checkPath` cover `sourceFile`?
   * Highest tier wins; null when no tier covers it (the plan's "0 otherwise").
   */
  weightFor(
    checkPath: string,
    sourceFile: string,
    opts?: { importReach?: (from: string, to: string) => boolean }
  ): CoverHit | null {
    if (!checkPath || !sourceFile) return null;
    this.load();

    const ck = norm(checkPath);
    const src = norm(sourceFile);
    for (const [testKey, covered] of Object.entries(this.data.coverage)) {
      if (!(testKey.endsWith(ck) || ck.endsWith(testKey))) continue;
      if (covered.some(p => p.endsWith(src) || src.endsWith(p))) {
        return { weight: TDM_WEIGHTS.coverage, source: 'coverage' };
      }
    }

    if (relatedByConvention(ck, src)) return { weight: TDM_WEIGHTS.related, source: 'related' };

    if (opts?.importReach) {
      try {
        if (opts.importReach(ck, src)) return { weight: TDM_WEIGHTS.import, source: 'import' };
      } catch { /* the graph being unavailable must never break attribution */ }
    }
    return null;
  }

  /** For /self-style reporting: how many coverage-proven mappings exist. */
  stats(): { coverageChecks: number; coverageEdges: number } {
    this.load();
    const checks = Object.keys(this.data.coverage);
    return { coverageChecks: checks.length, coverageEdges: checks.reduce((a, k) => a + this.data.coverage[k].length, 0) };
  }
}
