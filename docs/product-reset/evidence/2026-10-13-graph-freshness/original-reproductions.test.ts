import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../graph/graph.store';
import { SqliteGraphStore } from '../graph/sqlite.graph.store';
import { StaticAnalyzer } from '../graph/static.analyzer';
import { CodebaseIndexer } from '../graph/indexer';
import { SemanticAugmenter } from '../graph/semantic.augmenter';
import { computePageRank, formatRepoMapOutline } from '../graph/pagerank';
import { GraphNode } from '../graph/models';

const node = (id: string, filePath = id): GraphNode => ({ id, filePath, name: id, type: 'FUNCTION', signature: `function ${id}() {}` });
let dir: string;
let store: SqliteGraphStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-graph-freshness-'));
  store = new SqliteGraphStore(path.join(dir, 'graph.db'));
  expect(store.isAvailable()).toBe(true);
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function source(name = 'a.ts', text = 'export function oldName() { return 1; }') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}
function config() { fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true }, include: ['*.ts', '*.tsx'] })); }

test('same-size edit with restored mtime remains stale across restart', async () => {
  const file = source('a.ts', 'export const value = 1;');
  const past = new Date(1_700_000_000_000);
  fs.utimesSync(file, past, past);
  store.addNode(node('file:a.ts', 'a.ts'));
  store.recordFileHashes(dir);
  const stamp = fs.statSync(file);
  await new Promise(resolve => setTimeout(resolve, 15));
  fs.writeFileSync(file, 'export const value = 2;');
  fs.utimesSync(file, past, past);
  expect(fs.statSync(file).mtimeMs).toBe(stamp.mtimeMs);
  expect(fs.statSync(file).size).toBe(stamp.size);
  expect(fs.statSync(file).ctimeMs).not.toBe(stamp.ctimeMs);
  const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
  try { expect(reopened.staleFiles(dir)).toEqual({ changed: ['a.ts'], deleted: [] }); }
  finally { reopened.close(); }
});

test('per-file deletion preserves similarly named files and foreign symbol IDs', () => {
  store.addNode(node('file:a.ts', 'a.ts'));
  store.addNode(node('func:a.ts:gone', 'a.ts'));
  store.addNode(node('file:a.ts.extra.ts', 'a.ts.extra.ts'));
  store.addNode(node('func:other.ts:a.ts-helper', 'other.ts'));
  expect(store.removeFileNodes('a.ts')).toBe(2);
  expect([...store.getGraph().nodes.keys()]).toEqual(['file:a.ts.extra.ts', 'func:other.ts:a.ts-helper']);
});

test('single-file refresh preserves similarly named files', () => {
  config(); const file = source(); source('a.ts.extra.ts', 'export function keepMe() { return 2; }');
  const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject();
  expect(store.getNode('func:a.ts.extra.ts:keepMe')).toBeDefined();
  fs.writeFileSync(file, 'export function newName() { return 3; }');
  analyzer.analyzeSingleFile(file);
  expect(store.getNode('func:a.ts:oldName')).toBeUndefined();
  expect(store.getNode('func:a.ts:newName')).toBeDefined();
  expect(store.getNode('func:a.ts.extra.ts:keepMe')).toBeDefined();
});

test('unavailable parse input throws before removing the last good file graph', () => {
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject();
  fs.rmSync(file);
  expect(() => analyzer.analyzeSingleFile(file)).toThrow();
  expect(store.getNode('func:a.ts:oldName')).toBeDefined();
});

test('failed refresh does not certify the failed source hash', async () => {
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject();
  store.recordFileHashes(dir);
  fs.writeFileSync(file, 'export function newName() { return 999; }');
  const parse = jest.spyOn(analyzer, 'analyzeSingleFile').mockImplementation(() => { throw new Error('fixture parse unavailable'); });
  const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
  await indexer.refreshStale();
  expect(store.staleFiles(dir).changed).toEqual(['a.ts']);
  expect(store.getNode('func:a.ts:oldName')).toBeDefined();
  parse.mockRestore();
  await indexer.refreshStale();
  expect(store.staleFiles(dir).changed).toEqual([]);
  expect(store.getNode('func:a.ts:newName')).toBeDefined();
  const parseAgain = jest.spyOn(analyzer, 'analyzeSingleFile');
  await indexer.refreshStale();
  expect(parseAgain).not.toHaveBeenCalled();
});

test('explicitly republishing a graph invalidates cached ranking at equal counts', () => {
  const g = new GraphStore(':memory:');
  ['a', 'b', 'c'].forEach(id => g.addNode(node(id)));
  g.addEdge({ sourceId: 'a', targetId: 'b', type: 'CALLS' });
  const before = computePageRank(g);
  const graph = g.getGraph(); graph.edges[0] = { sourceId: 'a', targetId: 'c', type: 'CALLS' }; g.setGraph(graph);
  const after = computePageRank(g);
  expect(after.get('c')!).toBeGreaterThan(after.get('b')!);
  expect(after.get('c')).not.toBe(before.get('c'));
  expect(computePageRank(g)).toBe(after);
});

test('outline keys distinguish absent and explicitly empty headers', () => {
  const g = new GraphStore(':memory:'); g.addNode(node('alpha', 'alpha.ts'));
  expect(formatRepoMapOutline(g, 100)).toContain('[RepoMap]');
  const custom = formatRepoMapOutline(g, 100, [], '');
  expect(custom).not.toContain('[RepoMap]');
  expect(custom).toContain('function alpha');
});

test('outline keys distinguish one comma-containing focus term from two terms', () => {
  const g = new GraphStore(':memory:');
  g.addNode(node('gamma', 'gamma.ts')); g.addNode(node('alpha', 'alpha.ts'));
  const literal = formatRepoMapOutline(g, 10, ['alpha,beta']);
  const separate = formatRepoMapOutline(g, 10, ['alpha', 'beta']);
  expect(literal).toContain('function gamma');
  expect(separate).toContain('function alpha');
});

test('rename removes the old path and discovers its new TypeScript path', async () => {
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject(); store.recordFileHashes(dir);
  fs.renameSync(file, path.join(dir, 'renamed.ts'));
  const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
  await indexer.refreshStale();
  expect(store.getNode('file:a.ts')).toBeUndefined();
  expect(store.getNode('func:renamed.ts:oldName')).toBeDefined();
  expect(store.staleFiles(dir)).toEqual({ changed: [], deleted: [] });
});

test('refresh retains incoming calls and imports to surviving symbols without duplicate edges', () => {
  config(); const file = source('a.ts', 'export function target() { return 1; }');
  source('caller.ts', "import { target } from './a'; export function caller() { return target(); }");
  const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject();
  const incoming = store.getEdgesTo('func:a.ts:target').filter(e => e.type === 'CALLS');
  expect(incoming).toHaveLength(1);
  fs.writeFileSync(file, 'export function target() { return 999; }');
  analyzer.analyzeSingleFile(file); analyzer.analyzeSingleFile(file);
  expect(store.getEdgesTo('func:a.ts:target').filter(e => e.type === 'CALLS')).toEqual(incoming);
  expect(store.getEdgesFrom('file:caller.ts').filter(e => e.type === 'IMPORTS')).toEqual([{ sourceId: 'file:caller.ts', targetId: 'file:a.ts', type: 'IMPORTS' }]);
});

