import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { spawnSync } from 'child_process';
import { StaticAnalyzer } from '../graph/static.analyzer';
import { GraphStore } from '../graph/graph.store';
import { SqliteGraphStore } from '../graph/sqlite.graph.store';
import { CodebaseIndexer } from '../graph/indexer';
import { SemanticAugmenter } from '../graph/semantic.augmenter';
import { TreeSitterAnalyzer } from '../graph/treesitter.analyzer';

const { loadAnalyzer } = require('./fixtures/compiler-lifetime.cjs');
const BaselineAnalyzer = loadAnalyzer(path.join(process.cwd(), 'docs/product-reset/evidence/2026-10-13-indexing-work/baseline')).StaticAnalyzer as typeof StaticAnalyzer;
type Location = { startLine: number; endLine: number; signature: string };
const locate = (analyzer: StaticAnalyzer, node: ts.Node, source: ts.SourceFile): Location =>
  (analyzer as unknown as { locOf(node: ts.Node, source: ts.SourceFile): Location }).locOf(node, source);

afterEach(() => { jest.restoreAllMocks(); });

test.each([
  'export function f() {\n const x = 1;\n return x;\n}',
  '/** comment */\r\n\texport class C {\r\n method() { return 2; }\r\n}',
  '\uFEFF// header\nexport const value = 1; export function sameLine() { return value; }',
  'export const text = `line one\nline two`;\n',
  'export function f() {\r return 1;\r}',
  'export function f() {\u2028 return 1;\u2029}',
  `export function ${'a'.repeat(220)}() { return 1; }`,
  `export function f() {\n${'let value = 1;\n'.repeat(2000)}}`,
  ...[199, 200, 201].map(length => `export const value = "${'x'.repeat(length - 'export const value = "";'.length)}";`),
  `export function f(value = "\uD800") {\n /*${'x'.repeat(5000)}*/\n return value;\n}`,
  ...[4096, 4097].map(length => `export function f(value = "\uD800") {\n/*${'x'.repeat(length)}*/\n return value;\n}`),
  `export function f(value = "${'🙂'.repeat(250)}") {\n/*${'x'.repeat(5000)}*/\n return value;\n}`,
  '',
])('source spans and signatures exactly match the starting analyzer: %#', text => {
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.ES2022, true);
  const before = new BaselineAnalyzer('/owned-fixture', new GraphStore(':memory:'));
  const after = new StaticAnalyzer('/owned-fixture', new GraphStore(':memory:'));
  const visit = (node: ts.Node) => { expect(locate(after, node, source)).toEqual(locate(before, node, source)); ts.forEachChild(node, visit); };
  visit(source);
});

test.each([false, true])('signature extraction requests one bounded segment from its own node: multiline=%s', multiline => {
  const text = `${multiline ? 'export function value() {\n return 1;\n}' : 'export const value = 1;'} export const large = '${'x'.repeat(300000)}';`;
  const source = ts.createSourceFile('minified.ts', text, ts.ScriptTarget.ES2022, true);
  const node = source.statements[0];
  const analyzer = new StaticAnalyzer('/owned-fixture', new GraphStore(':memory:'));
  const expected = locate(new BaselineAnalyzer('/owned-fixture', new GraphStore(':memory:')), node, source);
  const ownText = jest.spyOn(node, 'getText');
  const split = jest.spyOn(String.prototype, 'split');
  let actual: Location;
  let segments: unknown, requests: unknown;
  try {
    actual = locate(analyzer, node, source);
    segments = split.mock.calls.map(args => [...args]);
    requests = ownText.mock.calls.map(args => [...args]);
  } finally { split.mockRestore(); ownText.mockRestore(); }
  expect(actual!).toEqual(expected);
  expect(segments).toEqual([['\n', 1]]);
  expect(requests).toEqual([[source]]);
});

test('large discovery preserves exact order, existing duplicates, known paths and full-index threshold without array scans', async () => {
  const root = '/owned-fixture';
  const store = new SqliteGraphStore(':memory:');
  try {
    const changed = ['prior.ts', 'prior.ts'];
    const paths = Array.from({ length: 5000 }, (_, i) => path.join(root, `path-${i}.ts`));
    const known = new Set(['known.ts']);
    const candidates = [path.join(root, 'known.ts'), path.join(root, 'prior.ts'), ...paths, ...paths.slice(0, 100)];
    jest.spyOn(store, 'staleFiles').mockReturnValue({ changed, deleted: [] });
    jest.spyOn(store, 'recordedFiles').mockReturnValue(known);
    jest.spyOn(TreeSitterAnalyzer.prototype, 'getProjectFiles').mockReturnValue(paths.slice(100, 200));
    const analyzer = new StaticAnalyzer(root, store);
    jest.spyOn(analyzer, 'getProjectFiles').mockReturnValue(candidates);
    const compiler = jest.spyOn(analyzer, 'createProgram');
    const includes = jest.spyOn(changed, 'includes');
    const indexer = new CodebaseIndexer(root, store, analyzer, {} as SemanticAugmenter);
    const rebuild = jest.spyOn(indexer, 'buildAstIndex').mockResolvedValue(0);
    const result = await indexer.refreshStale({ fullThreshold: 200 });
    expect([...changed]).toEqual(['prior.ts', 'prior.ts', ...paths.map(p => path.relative(root, p))]);
    expect(result).toEqual({ supported: true, changed: 5002, deleted: 0, full: true });
    expect(includes).not.toHaveBeenCalled();
    expect(compiler).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledTimes(1);
  } finally { store.close(); }
});

test('duplicate discovery parses a newly added file once and persists its exact graph', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-discovery-work-'));
  const store = new SqliteGraphStore(path.join(dir, 'graph.db'));
  try {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
    const existing = path.join(dir, 'existing.ts'); fs.writeFileSync(existing, 'export function existing() { return 1; }');
    const analyzer = new StaticAnalyzer(dir, store); analyzer.analyzeProject(); store.recordFileHashes(dir);
    const added = path.join(dir, 'new.ts'); fs.writeFileSync(added, "import { existing } from './existing'; export function added() { return existing(); }");
    jest.spyOn(analyzer, 'getProjectFiles').mockReturnValue([existing, added, added]);
    jest.spyOn(TreeSitterAnalyzer.prototype, 'getProjectFiles').mockReturnValue([added]);
    const parse = jest.spyOn(analyzer, 'analyzeSingleFile');
    const indexer = new CodebaseIndexer(dir, store, analyzer, {} as SemanticAugmenter);
    expect(await indexer.refreshStale()).toEqual({ supported: true, changed: 1, deleted: 0, full: false });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(store.getEdgesTo('func:existing.ts:existing').filter(e => e.type === 'CALLS')).toHaveLength(1);
    const reopened = new SqliteGraphStore(path.join(dir, 'graph.db'));
    try { await reopened.loadFromDisk(); expect(reopened.getGraph()).toEqual(store.getGraph()); expect(reopened.staleFiles(dir)).toEqual({ changed: [], deleted: [] }); }
    finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('short signatures do not keep an eight-MiB source body alive after collection', () => {
  const child = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures/signature-retention.cjs')], { encoding: 'utf8', cwd: process.cwd(), timeout: 20_000 });
  expect({ exit: child.status, stderr: child.stderr }).toEqual({ exit: 0, stderr: '' });
  expect(JSON.parse(child.stdout).retained_heap_bytes).toBeLessThan(2 * 1024 * 1024);
}, 25_000);
