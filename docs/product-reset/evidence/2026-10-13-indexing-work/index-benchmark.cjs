const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), ts = require('typescript');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const { loadAnalyzer } = require('../../../../src/__tests__/fixtures/compiler-lifetime.cjs');
function indexer(root) {
  const { GraphStore } = loadAnalyzer(root);
  class SqliteGraphStore extends GraphStore {
    constructor(changed, known) { super(':memory:'); this.changed = [...changed]; this.known = known; }
    isAvailable() { return true; } staleFiles() { return { changed: this.changed, deleted: [] }; } recordedFiles() { return this.known; }
  }
  const deps = { './static.analyzer': {}, './treesitter.analyzer': { TreeSitterAnalyzer: class { getProjectFiles() { return []; } } }, './semantic.augmenter': {}, './graph.store': { GraphStore }, './sqlite.graph.store': { SqliteGraphStore }, '../utils': { Logger: { info() {}, warn() {} } }, './file.graph': {} };
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(fs.readFileSync(path.join(root, 'src/graph/indexer.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports, id => Object.hasOwn(deps, id) ? deps[id] : require(id));
  return { ...exports, SqliteGraphStore };
}
const baseline = path.join(__dirname, 'baseline');
const modules = { before: { ...loadAnalyzer(baseline), ...indexer(baseline) }, after: { ...loadAnalyzer(process.cwd()), ...indexer(process.cwd()) } };
function discovery(module, count, unchanged) {
  const root = '/owned-fixture', candidates = Array.from({ length: count }, (_, i) => path.join(root, `source-${String(i).padStart(6, '0')}.ts`));
  const rels = candidates.map(p => path.relative(root, p));
  const initial = unchanged ? [] : rels.filter((_, i) => i % 10 === 0), known = new Set(unchanged ? rels : []);
  const store = new module.SqliteGraphStore(initial, known);
  const analyzer = { getProjectFiles: () => [...candidates, ...candidates.filter((_, i) => i % 7 === 0)] };
  const indexer = new module.CodebaseIndexer(root, store, analyzer, {});
  let full = 0; indexer.buildAstIndex = async () => { full++; return 0; };
  return { run: () => indexer.refreshStale({ fullThreshold: 0 }), output: result => ({ result, paths: store.changed, full }), close() {} };
}
function signature(module, lines) {
  const text = `/** leading comment */\nexport function sample(value: number) {\n${'  value += 1;\n'.repeat(lines)}  return value;\n}\n`;
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.ES2022, true), node = source.statements[0];
  source.getLineAndCharacterOfPosition(source.end); node.getStart(source);
  const analyzer = new module.StaticAnalyzer('/owned-fixture', new module.GraphStore(':memory:'));
  return { run: () => { let last; for (let i = 0; i < 200; i++) last = analyzer.locOf(node, source); return last; }, output: value => value, close() {} };
}
function project(module, count, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-index-cost-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `source${i}.ts`), `export function sample(value: number) {\n${'value += 1;\n'.repeat(lines)} return value;\n}\n`);
  const store = new module.GraphStore(':memory:'), analyzer = new module.StaticAnalyzer(root, store);
  return { run: () => analyzer.analyzeProject(), output: () => ({ nodes: [...store.getGraph().nodes], edges: store.getGraph().edges }), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function main() {
  assert.equal(typeof global.gc, 'function'); const started = new Date().toISOString(), results = [], profile = process.argv.includes('--profile');
  const cases = [['discovery', 100, false], ['discovery', 1000, false], ['discovery', 10000, false], ['discovery', 10000, true], ['signature', 10], ['signature', 1000], ['signature', 10000], ['project', 20, 10], ['project', 1, 10000], ['project', 20, 1000]];
  for (const [kind, size, shape] of cases) {
    let expected; const raw = { before: [], after: [] };
    for (let i = -3; i < (profile ? 3 : 11); i++) for (const side of profile ? ['before'] : i % 2 ? ['after', 'before'] : ['before', 'after']) {
      const module = modules[side], f = kind === 'discovery' ? discovery(module, size, shape) : kind === 'signature' ? signature(module, size) : project(module, size, shape);
      try { global.gc(); const start = performance.now(); const value = await f.run(); const elapsed = performance.now() - start;
        const output = f.output(value); if (expected === undefined) expected = output; else assert.deepEqual(output, expected);
        if (i >= 0) raw[side].push(elapsed);
      } finally { f.close(); }
    }
    const stats = side => { const a = [...raw[side]].sort((a,b) => a-b); return { p50_ms: a[Math.floor(a.length/2)], p95_ms: a[a.length-1], raw_ms: raw[side] }; };
    results.push({ kind, size, shape, warmups: 3, repetitions: profile ? 3 : 11, discarded: 0, before: stats('before'), after: profile ? undefined : stats('after'), correctness_sha256: crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex') });
  }
  console.log(JSON.stringify({ started, finished: new Date().toISOString(), scope: 'Owned offline phases; fixture/module creation and assertions excluded; discovery uses real refresh control flow with persistence/parser work isolated; project includes real TS parsing + extraction but excludes disk save; no installed latency/RSS/energy claim', ordering: 'AB/BA with GC before operations, no parallel tests/builds', machine: { node: process.version, typescript: ts.version, arch: os.arch(), cpu: os.cpus()[0].model, cores: os.cpus().length, ram_bytes: os.totalmem() }, results }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
