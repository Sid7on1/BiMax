import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { GraphStore } from '../graph/graph.store';
import { SqliteGraphStore } from '../graph/sqlite.graph.store';
import { ImpactEngine } from '../graph/impact.engine';
import { computePageRank } from '../graph/pagerank';
import { GraphNode } from '../graph/models';

const evidence = path.join(__dirname, '../../docs/product-reset/evidence/2026-10-13-performance');
function load<T>(file: string, dependencies: Record<string, unknown> = {}): T {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(evidence, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', code)(exports, (id: string) => id in dependencies ? dependencies[id] : require(id));
  return exports as T;
}
const OldGraph = load<{ GraphStore: typeof GraphStore }>('baseline/src/graph/graph.store.ts').GraphStore;
const OldImpact = load<{ ImpactEngine: typeof ImpactEngine }>('baseline/src/graph/impact.engine.ts').ImpactEngine;
const node = (id: string, filePath = 'keep.ts'): GraphNode => ({ id, name: id, filePath, type: 'FUNCTION', riskScore: Number(id) || 0 });

function seed(g: GraphStore, n: number) {
  for (let i = 0; i < n; i++) g.addNode(node(String(i), i < n / 3 ? 'remove.ts' : 'keep.ts'));
  for (let i = 1; i < n; i++) {
    g.addEdge({ sourceId: String(i - 1), targetId: String(i), type: 'CALLS' });
    g.addEdge({ sourceId: String(i), targetId: '0', type: 'IMPORTS' });
  }
  g.addEdge({ sourceId: '0', targetId: 'missing', type: 'CALLS' });
}

test('bulk graph removal preserves exact sequential end state and both adjacency directions', () => {
  const before = new OldGraph(':memory:'); const after = new GraphStore(':memory:'); seed(before, 300); seed(after, 300);
  const removed = Array.from({ length: 100 }, (_, i) => String(i)); removed.push('missing', 'missing');
  for (const id of removed) before.removeNode(id);
  const revision = after.getRevision(); after.removeNodes(removed);
  expect(after.getRevision()).toBe(revision + 1);
  expect([...after.getGraph().nodes]).toEqual([...before.getGraph().nodes]);
  expect(after.getGraph().edges).toEqual(before.getGraph().edges);
  for (let i = 0; i < 300; i++) {
    expect(after.getEdgesFrom(String(i))).toEqual(before.getEdgesFrom(String(i)));
    expect(after.getEdgesTo(String(i))).toEqual(before.getEdgesTo(String(i)));
  }
  expect(computePageRank(after)).toEqual(computePageRank(before));
  after.removeNodes([]); expect(after.getRevision()).toBe(revision + 1);
});

test('SQLite file invalidation rebuilds adjacency once and retains the similarly named file', () => {
  const g = new SqliteGraphStore(':memory:');
  try {
    seed(g, 900); g.addNode(node('similar', 'remove.ts.extra.ts'));
    const indices = jest.spyOn(g as unknown as { rebuildIndices(): void }, 'rebuildIndices');
    expect(g.removeFileNodes('remove.ts')).toBe(300);
    expect(indices).toHaveBeenCalledTimes(1);
    expect(g.getNode('similar')).toBeDefined();
    expect(g.getGraph().nodes.size).toBe(601);
    expect(g.getGraph().edges.some(e => Number(e.sourceId) < 300 || Number(e.targetId) < 300)).toBe(false);
  } finally { g.close(); }
});

test('frontier traversal preserves BFS order, depth, direction, cycles and missing-node behavior', () => {
  const g = new GraphStore(':memory:'); seed(g, 200);
  for (let i = 2; i < 200; i++) g.addEdge({ sourceId: '0', targetId: String(i), type: 'CALLS' });
  const before = new OldImpact(g), after = new ImpactEngine(g);
  for (const start of ['0', '100', 'missing']) for (const depth of [-1, 0, .1, 1, 2, 4, NaN, Infinity]) {
    expect(after.getForwardDependencies(start, depth)).toEqual(before.getForwardDependencies(start, depth));
    expect(after.getReverseDependencies(start, depth)).toEqual(before.getReverseDependencies(start, depth));
  }
  expect(after.calculateBlastRadius('100')).toEqual(before.calculateBlastRadius('100'));
});

test('wide BFS does not shift array fronts', () => {
  const g = new GraphStore(':memory:'); for (let i = 0; i < 10000; i++) g.addNode(node(String(i)));
  for (let i = 1; i < 10000; i++) g.addEdge({ sourceId: '0', targetId: String(i), type: 'CALLS' });
  const shift = jest.spyOn(Array.prototype, 'shift');
  let results: GraphNode[];
  try {
    const calls = shift.mock.calls.length;
    results = new ImpactEngine(g).getForwardDependencies('0', 2);
    expect(shift.mock.calls.length - calls).toBe(0);
  } finally { shift.mockRestore(); }
  expect(results!.map(n => n.id)).toEqual(Array.from({ length: 9999 }, (_, i) => String(i + 1)));
});

test('cycles and parallel references visit each real node once within finite depth', () => {
  const g = new GraphStore(':memory:'); g.addNode(node('0')); g.addNode(node('1'));
  g.addEdge({ sourceId: '0', targetId: '1', type: 'CALLS' });
  g.addEdge({ sourceId: '0', targetId: '1', type: 'IMPORTS' });
  g.addEdge({ sourceId: '1', targetId: '0', type: 'CALLS' });
  expect(new ImpactEngine(g).getForwardDependencies('0', 4).map(n => n.id)).toEqual(['1']);
});

test('FIFO compaction clears consumed IDs and bounds narrow-graph queue storage', () => {
  const g = new GraphStore(':memory:');
  for (let i = 0; i < 10000; i++) g.addNode(node(String(i)));
  for (let i = 1; i < 10000; i++) g.addEdge({ sourceId: String(i - 1), targetId: String(i), type: 'CALLS' });
  const nativeSlice = Array.prototype.slice;
  let slices = 0, maxSlots = 0, copies = 0, cleared = true;
  const slice = jest.spyOn(Array.prototype, 'slice').mockImplementation(function (this: unknown[], start = 0, end?: number) {
    if (start >= 1024 && typeof this[this.length - 1] === 'string') {
      slices++; maxSlots = Math.max(maxSlots, this.length); copies += Math.max(0, this.length - start);
      for (let i = 0; i < start; i++) if (this[i] !== '') cleared = false;
    }
    return nativeSlice.call(this, start, end);
  });
  let result: GraphNode[];
  try { result = new ImpactEngine(g).getForwardDependencies('0', Infinity); }
  finally { slice.mockRestore(); }
  expect(result!.map(n => n.id)).toEqual(Array.from({ length: 9999 }, (_, i) => String(i + 1)));
  expect(slices).toBeGreaterThan(0); expect(cleared).toBe(true);
  expect(maxSlots).toBeLessThanOrEqual(1025); expect(copies).toBeLessThanOrEqual(10000);
});
