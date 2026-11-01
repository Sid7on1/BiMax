import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { StaticAnalyzer } from '../graph/static.analyzer';
import { GraphStore } from '../graph/graph.store';
import { ImpactEngine } from '../graph/impact.engine';
import { computePageRank } from '../graph/pagerank';
import { SqliteGraphStore } from '../graph/sqlite.graph.store';

const fixture = path.join(__dirname, 'fixtures/compiler-lifetime.cjs');

test.each(['full', 'single', 'missing', 'checker-failure', 'publish-failure', 'full-failure', 'shared', 'repeat'])(
  'compiler objects become collectible after %s while the analyzer and graph stay live', mode => {
    const child = spawnSync(process.execPath, ['--expose-gc', fixture, mode], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    expect({ exit: child.status, stderr: child.stderr }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(child.stdout)).toMatchObject({ mode, collected: true });
  }, 25_000
);

test('full and shared-snapshot extraction exactly match the frozen graph, including restart and consumers', async () => {
  const { loadAnalyzer } = require('./fixtures/compiler-lifetime.cjs');
  const baseline = loadAnalyzer(path.join(process.cwd(), 'docs/product-reset/evidence/2026-10-13-index-memory/baseline'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-compiler-results-'));
  const store = new SqliteGraphStore(path.join(dir, 'graph.db'));
  try {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
    fs.writeFileSync(path.join(dir, 'a.ts'), "declare const bus: any; export function target(n: number) { const v = n + 1; bus.emit('ready', v); return v; } export class Service { run() { return target(3); } }");
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { target, Service } from './a'; declare const bus: any; export function caller() { bus.on('ready', target); const s = new Service(); return s.run() + target(2); }");
    const expected = new baseline.GraphStore(':memory:');
    const old = new baseline.StaticAnalyzer(dir, expected), current = new StaticAnalyzer(dir, store);
    old.analyzeProject(); current.analyzeProject();
    expect(store.getGraph()).toEqual(expected.getGraph());
    expect(store.getEdgesTo('func:a.ts:target').some(edge => edge.type === 'CALLS')).toBe(true);
    expect(store.getEdgesTo('event:ready').map(edge => edge.type)).toEqual(['PUBLISHES_TO', 'SUBSCRIBES_TO']);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function target(n: number) { const value = n + 8; return value; }');
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { target } from './a'; export function caller() { return target(4); }");
    const beforeSnapshot = old.createProgram(), afterSnapshot = current.createProgram();
    for (const name of ['b.ts', 'a.ts']) {
      old.analyzeSingleFile(path.join(dir, name), beforeSnapshot);
      current.analyzeSingleFile(path.join(dir, name), afterSnapshot);
    }
    expect(store.getGraph()).toEqual(expected.getGraph());
    expect(new ImpactEngine(store).getForwardDependencies('file:b.ts', Infinity).map(n => n.id)).toContain('func:a.ts:target');
    expect(computePageRank(store)).toEqual(computePageRank(expected));
    await store.saveToDisk();
    const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
    try { await reopened.loadFromDisk(); expect(reopened.getGraph()).toEqual(store.getGraph()); }
    finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed extraction preserves the published graph and a subsequent parse uses fresh source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-compiler-retry-'));
  try {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
    const file = path.join(dir, 'a.ts'); fs.writeFileSync(file, 'export function oldName() { return 1; }');
    const store = new GraphStore(':memory:'), analyzer = new StaticAnalyzer(dir, store);
    analyzer.analyzeProject(); const before = store.getGraph();
    const publication = jest.spyOn(store, 'setGraph').mockImplementation(() => { throw new Error('owned publish failure'); });
    fs.writeFileSync(file, 'export function newName() { return 2; }');
    expect(() => analyzer.analyzeSingleFile(file)).toThrow('owned publish failure');
    expect(store.getGraph()).toBe(before);
    publication.mockRestore(); analyzer.analyzeSingleFile(file);
    expect(store.getNode('func:a.ts:oldName')).toBeUndefined();
    expect(store.getNode('func:a.ts:newName')).toBeDefined();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
