const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), ts = require('typescript');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
function modules(root) {
  const logger = { Logger: { info() {}, warn() {}, error() {} } };
  function load(rel, deps) {
    const exports = {};
    new Function('exports', 'require', ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText)(exports, id => Object.hasOwn(deps, id) ? deps[id] : require(id));
    return exports;
  }
  const graph = load('src/graph/graph.store.ts', { '../utils': logger });
  const publication = load('src/graph/file.graph.ts', {});
  return { ...graph, ...load('src/graph/static.analyzer.ts', { '../utils': logger, './graph.store': graph, './file.graph': publication }) };
}
function fixture(dir, count) {
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }));
  for (let i = 0; i < count; i++) {
    let source = i ? `import { f0 as previous } from './f${i - 1}';\n` : '';
    for (let j = 0; j < 12; j++) source += `export function f${j}(value: number): number { const local = value + ${j}; return ${i && j === 0 ? 'previous(local)' : 'local'}; }\n`;
    fs.writeFileSync(path.join(dir, `f${i}.ts`), source);
  }
}
async function settle() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); } }
async function child() {
  assert.equal(typeof global.gc, 'function');
  const [side, countText, operation, diagnostic] = process.argv.slice(3), count = Number(countText);
  const root = side === 'before' ? path.join(__dirname, 'baseline') : process.cwd();
  const { StaticAnalyzer, GraphStore } = modules(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-compiler-memory-'));
  try {
    fixture(dir, count);
    // Keep graph + analyzer alive while measuring idle retention. Compiler locals die on return.
    const store = new GraphStore(':memory:'), analyzer = new StaticAnalyzer(dir, store);
    await settle(); const startMemory = process.memoryUsage();
    let programMs = 0, extractionMs = 0, publicationMs = 0, publications = 0;
    const create = analyzer.createProgram.bind(analyzer);
    analyzer.createProgram = () => { const start = performance.now(); const p = create(); programMs += performance.now() - start; return p; };
    const publish = store.setGraph.bind(store);
    store.setGraph = data => { const start = performance.now(); publish(data); publicationMs += performance.now() - start; publications++; };
    const start = performance.now();
    if (operation === 'full') analyzer.analyzeProject();
    else if (operation === 'single') analyzer.analyzeSingleFile(path.join(dir, 'f0.ts'));
    else if (operation === 'batch') {
      // Matches refreshStale's one fresh snapshot for all changed TS files.
      (() => { const snapshot = analyzer.createProgram(); for (let i = 0; i < Math.min(count, 20); i++) analyzer.analyzeSingleFile(path.join(dir, `f${i}.ts`), snapshot); })();
    } else if (operation === 'missing') assert.throws(() => analyzer.analyzeSingleFile(path.join(dir, 'missing.ts')));
    else throw Error(`Unknown operation ${operation}`);
    extractionMs = performance.now() - start;
    await settle(); const idleMemory = process.memoryUsage();
    const output = { nodes: [...store.getGraph().nodes], edges: store.getGraph().edges };
    const digest = crypto.createHash('sha256').update(JSON.stringify(output)).digest('hex');
    const retainedChecker = Boolean(analyzer.typeChecker);
    let releasedMemory;
    if (diagnostic) { delete analyzer.typeChecker; await settle(); releasedMemory = process.memoryUsage(); }
    // Exercise the retained graph after GC: it must be usable without a compiler.
    for (const edge of output.edges) assert.deepEqual(store.getEdgesFrom(edge.sourceId).filter(e => e === edge), [edge]);
    assert.equal(store.getGraph().nodes.size, output.nodes.length);
    console.log(JSON.stringify({ side, count, operation, nodes: output.nodes.length, edges: output.edges.length, digest, retainedChecker,
      time_ms: { total: extractionMs, create_program: programMs, set_graph: publicationMs, publications },
      memory: { start: startMemory, idle: idleMemory, manually_released: releasedMemory, retained_heap_bytes: idleMemory.heapUsed - startMemory.heapUsed } }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function run(side, count, operation, diagnostic = false) {
  const p = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', side, String(count), operation, ...(diagnostic ? ['diagnostic'] : [])], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 });
  assert.equal(p.status, 0, p.stderr || p.stdout); return JSON.parse(p.stdout);
}
async function main() {
  if (process.argv[2] === '--child') return child();
  const started = new Date().toISOString();
  if (process.argv[2] === '--profile') {
    console.log(JSON.stringify({ started, runs: [run('before', 20, 'full', true), run('before', 200, 'full', true), run('before', 200, 'batch', true), run('before', 200, 'missing', true)], finished: new Date().toISOString() }, null, 2)); return;
  }
  const results = [];
  for (const count of [20, 200]) for (const operation of ['full', 'single', 'batch', 'missing']) {
    const runs = { before: [], after: [] };
    for (let i = 0; i < 5; i++) for (const side of i % 2 ? ['after', 'before'] : ['before', 'after']) runs[side].push(run(side, count, operation));
    for (const output of [...runs.before, ...runs.after]) assert.equal(output.digest, runs.before[0].digest);
    const stats = side => { const sorted = runs[side].map(r => r.memory.retained_heap_bytes).sort((a,b) => a-b); const times = runs[side].map(r => r.time_ms.total).sort((a,b) => a-b); return { p50_retained_heap_bytes: sorted[2], max_retained_heap_bytes: sorted[4], p50_ms: times[2], max_ms: times[4], raw: runs[side] }; };
    results.push({ count, operation, before: stats('before'), after: stats('after') });
  }
  console.log(JSON.stringify({ started, finished: new Date().toISOString(), scope: 'Owned generated TypeScript fixture; independent Node processes; post-GC retained heap with live graph/analyzer; not installed application RSS, peak memory, energy or task latency', ordering: '5 AB/BA paired repetitions, no discarded samples, no parallel builds/tests, no warmups (fresh compiler/process per sample; module loading/fixture creation excluded)', machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, arch: os.arch(), ram: os.totalmem(), node: process.version }, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
