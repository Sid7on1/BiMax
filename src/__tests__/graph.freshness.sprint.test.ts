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

test('a source edited again during refresh stays pending rather than certifying unparsed bytes', async () => {
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject(); store.recordFileHashes(dir);
  fs.writeFileSync(file, 'export function secondName() { return 222; }');
  const parse = analyzer.analyzeSingleFile.bind(analyzer);
  const changedDuringParse = jest.spyOn(analyzer, 'analyzeSingleFile').mockImplementation(abs => {
    parse(abs); fs.writeFileSync(abs, 'export function thirdName() { return 333; }');
  });
  const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
  await indexer.refreshStale();
  expect(store.getNode('func:a.ts:secondName')).toBeDefined();
  expect(store.staleFiles(dir).changed).toEqual(['a.ts']);
  changedDuringParse.mockRestore(); await indexer.refreshStale();
  expect(store.getNode('func:a.ts:thirdName')).toBeDefined();
  expect(store.staleFiles(dir).changed).toEqual([]);
});

test('unchanged cached ranking does not enumerate the graph again', () => {
  const g = new GraphStore(':memory:'); g.addNode(node('alpha', 'alpha.ts'));
  const expected = computePageRank(g);
  const enumerate = jest.spyOn(g.getGraph().nodes, 'values');
  expect(computePageRank(g)).toBe(expected);
  expect(enumerate).not.toHaveBeenCalled();
});

test('failed SQLite commit rolls back persisted graph and cannot advance freshness', async () => {
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject(); await store.saveToDisk(); store.recordFileHashes(dir);
  fs.writeFileSync(file, 'export function newName() { return 999; }');
  const db = (store as unknown as { db: import('../core/sqlite').SqliteDB }).db;
  const exec = db.exec.bind(db);
  const failure = jest.spyOn(db, 'exec').mockImplementation(sql => { if (sql === 'COMMIT') throw new Error('fixture commit failed'); exec(sql); });
  const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
  await expect(indexer.refreshStale()).rejects.toThrow('fixture commit failed');
  failure.mockRestore();
  const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
  try {
    await reopened.loadFromDisk();
    expect(reopened.getNode('func:a.ts:oldName')).toBeDefined();
    expect(reopened.getNode('func:a.ts:newName')).toBeUndefined();
    expect(reopened.staleFiles(dir).changed).toEqual(['a.ts']);
  } finally { reopened.close(); }
});

test('unavailable non-TS grammar preserves the last graph and pending hash', async () => {
  const { TreeSitterAnalyzer } = await import('../graph/treesitter.analyzer');
  const file = source('a.py', 'def old_name():\n    return 1\n');
  store.addNode(node('func:a.py:old_name', 'a.py')); store.recordFileHashes(dir);
  fs.writeFileSync(file, 'def new_name():\n    return 222\n');
  const unavailable = jest.spyOn(TreeSitterAnalyzer.prototype, 'analyzeSingleFile').mockImplementation(async () => false as unknown as Awaited<ReturnType<typeof TreeSitterAnalyzer.prototype.analyzeSingleFile>>);
  try {
    const indexer = new CodebaseIndexer(dir, store, new StaticAnalyzer(dir, store), {} as SemanticAugmenter);
    await indexer.refreshStale();
    expect(store.getNode('func:a.py:old_name')).toBeDefined();
    expect(store.staleFiles(dir).changed).toEqual(['a.py']);
  } finally { unavailable.mockRestore(); }
});

test('new Python path is discovered after a rename and its symbols survive restart', async () => {
  const { TreeSitterAnalyzer } = await import('../graph/treesitter.analyzer');
  const file = source('a.py', 'def old_name():\n    return 1\n');
  await new TreeSitterAnalyzer(dir, store).analyzeProject();
  expect(store.getNode('func:a.py:old_name')).toBeDefined();
  store.recordFileHashes(dir); fs.renameSync(file, path.join(dir, 'renamed.py'));
  const indexer = new CodebaseIndexer(dir, store, new StaticAnalyzer(dir, store), {} as SemanticAugmenter);
  await indexer.refreshStale();
  expect(store.getNode('func:a.py:old_name')).toBeUndefined();
  expect(store.getNode('func:renamed.py:old_name')).toBeDefined();
  const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
  try {
    await reopened.loadFromDisk(); expect(reopened.getNode('func:renamed.py:old_name')).toBeDefined();
    expect(reopened.staleFiles(dir)).toEqual({ changed: [], deleted: [] });
  } finally { reopened.close(); }
});

test('old SQLite schema receives ctime and rechecks its existing rows once', () => {
  const { openSqlite } = require('../core/sqlite') as typeof import('../core/sqlite');
  const legacyPath = path.join(dir, 'legacy.db'); const db = openSqlite(legacyPath)!;
  const file = source('legacy.ts', 'export const old = 1;'); const stamp = fs.statSync(file);
  const hash = require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex') as string;
  db.exec('CREATE TABLE file_hashes (path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)');
  db.prepare('INSERT INTO file_hashes VALUES (?, ?, ?, ?)').run('legacy.ts', hash, stamp.mtimeMs, stamp.size); db.close();
  const migrated = new SqliteGraphStore(legacyPath);
  try {
    expect(migrated.isAvailable()).toBe(true);
    expect(migrated.staleFiles(dir)).toEqual({ changed: [], deleted: [] });
    const state = (migrated as unknown as { db: import('../core/sqlite').SqliteDB }).db.prepare('SELECT ctime FROM file_hashes').get();
    expect(state.ctime).toBe(stamp.ctimeMs);
  } finally { migrated.close(); }
});

test('one compiler snapshot handles a changed-file batch; unchanged sync builds none', async () => {
  config(); const a = source('a.ts'); const b = source('b.ts', 'export function b() { return 2; }');
  const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject(); store.recordFileHashes(dir);
  fs.writeFileSync(a, 'export function a_new() { return 10; }');
  fs.writeFileSync(b, 'export function b_new() { return 20; }');
  const build = jest.spyOn(analyzer, 'createProgram');
  const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
  await indexer.refreshStale();
  expect(build).toHaveBeenCalledTimes(1);
  expect(store.getNode('func:a.ts:a_new')).toBeDefined(); expect(store.getNode('func:b.ts:b_new')).toBeDefined();
  await indexer.refreshStale(); expect(build).toHaveBeenCalledTimes(1);
});

test('outline numeric budget keys preserve infinite and non-finite input distinctions', () => {
  const g = new GraphStore(':memory:'); g.addNode(node('alpha', 'alpha.ts'));
  expect(formatRepoMapOutline(g, -Infinity)).toBe('');
  expect(formatRepoMapOutline(g, Infinity)).toContain('function alpha');
});

test('killing a refresh process after graph commit leaves a restartable pending hash without duplicate edges', async () => {
  const { fork } = await import('child_process');
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store);
  analyzer.analyzeProject(); await store.saveToDisk(); store.recordFileHashes(dir);
  fs.writeFileSync(file, 'export function after_crash() { return 999; }');
  const child = fork(path.join(__dirname, 'fixtures/graph-refresh-crash.js'), [dir, path.join(dir, 'graph.db')], {
    execArgv: ['-r', 'ts-node/register/transpile-only'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-2000); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const checkpoint = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Crash fixture did not reach checkpoint: ${stderr}`)), 12_000);
      child.once('message', value => { clearTimeout(timeout); resolve(value); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Early fixture exit: ${stderr}`)); });
    });
    expect(checkpoint).toEqual({ at: 'before-hash-publication' });
    child.kill('SIGKILL'); expect((await exit).signal).toBe('SIGKILL');
    const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
    try {
      await reopened.loadFromDisk();
      expect(reopened.getNode('func:a.ts:after_crash')).toBeDefined();
      expect(reopened.staleFiles(dir).changed).toEqual(['a.ts']);
      const recovery = new CodebaseIndexer(dir, reopened, new StaticAnalyzer(dir, reopened), {} as SemanticAugmenter);
      await recovery.refreshStale();
      expect(reopened.staleFiles(dir)).toEqual({ changed: [], deleted: [] });
      const graph = reopened.getGraph();
      expect(graph.nodes.has('func:a.ts:oldName')).toBe(false);
      expect(graph.nodes.has('func:a.ts:after_crash')).toBe(true);
      const edgeKeys = graph.edges.map(e => JSON.stringify([e.sourceId, e.targetId, e.type]));
      expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
      const expected = new GraphStore(':memory:'); new StaticAnalyzer(dir, expected).analyzeProject();
      expect([...graph.nodes]).toEqual([...expected.getGraph().nodes]);
      expect(graph.edges).toEqual(expected.getGraph().edges);
    } finally { reopened.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
}, 20_000);

test('failed deletion commit preserves its hash baseline so restart can prune the old graph', async () => {
  config(); const file = source(); const analyzer = new StaticAnalyzer(dir, store);
  analyzer.analyzeProject(); await store.saveToDisk(); store.recordFileHashes(dir); fs.rmSync(file);
  const db = (store as unknown as { db: import('../core/sqlite').SqliteDB }).db;
  const exec = db.exec.bind(db);
  const failure = jest.spyOn(db, 'exec').mockImplementation(sql => { if (sql === 'COMMIT') throw new Error('fixture deletion commit failed'); exec(sql); });
  const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
  await expect(indexer.refreshStale()).rejects.toThrow('fixture deletion commit failed'); failure.mockRestore();
  const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
  try {
    await reopened.loadFromDisk(); expect(reopened.getNode('func:a.ts:oldName')).toBeDefined();
    expect(reopened.staleFiles(dir)).toEqual({ changed: [], deleted: ['a.ts'] });
    await new CodebaseIndexer(dir, reopened, new StaticAnalyzer(dir, reopened), {} as SemanticAugmenter).refreshStale();
    expect(reopened.getGraph().nodes.size).toBe(0);
    expect(reopened.staleFiles(dir)).toEqual({ changed: [], deleted: [] });
    const persisted = new SqliteGraphStore(path.join(dir, 'graph.db'));
    try { await persisted.loadFromDisk(); expect(persisted.getGraph().nodes.size).toBe(0); }
    finally { persisted.close(); }
  } finally { reopened.close(); }
});
