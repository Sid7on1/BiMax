// Owned isolated process: real compiler, forced GC, live analyzer/graph, no user config access.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), ts = require('typescript');
const assert = require('node:assert/strict');
function loadAnalyzer(root = process.cwd()) {
  function load(rel, deps = {}) {
    const exports = {};
    new Function('exports', 'require', ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText)(exports, id => Object.hasOwn(deps, id) ? deps[id] : require(id));
    return exports;
  }
  const logger = { Logger: { info() {}, warn() {}, error() {} } };
  const graph = load('src/graph/graph.store.ts', { '../utils': logger });
  return { ...graph, ...load('src/graph/static.analyzer.ts', { '../utils': logger, './graph.store': graph, './file.graph': load('src/graph/file.graph.ts') }) };
}
async function gc() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); } }
async function main(mode) {
  assert.equal(typeof global.gc, 'function');
  const { StaticAnalyzer, GraphStore } = loadAnalyzer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-compiler-lifetime-'));
  const references = [];
  try {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function target(value: number) { const local = value + 1; return local; }');
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { target } from './a'; export function caller() { return target(2); }");
    const store = new GraphStore(':memory:'), analyzer = new StaticAnalyzer(dir, store);
    const original = analyzer.createProgram.bind(analyzer);
    analyzer.createProgram = () => {
      const program = original(), checker = program.getTypeChecker();
      references.push({ program: new WeakRef(program), checker: new WeakRef(checker), source: new WeakRef(program.getSourceFile(path.join(dir, 'a.ts'))) });
      if (mode === 'checker-failure') checker.getResolvedSignature = () => { throw Error('owned checker failure'); };
      return program;
    };
    if (mode === 'full') analyzer.analyzeProject();
    else if (mode === 'single') analyzer.analyzeSingleFile(path.join(dir, 'b.ts'));
    else if (mode === 'missing') assert.throws(() => analyzer.analyzeSingleFile(path.join(dir, 'missing.ts')), /Could not find source/);
    else if (mode === 'checker-failure') assert.throws(() => analyzer.analyzeSingleFile(path.join(dir, 'b.ts')), /owned checker failure/);
    else if (mode === 'publish-failure') {
      store.setGraph = () => { throw Error('owned publication failure'); };
      assert.throws(() => analyzer.analyzeSingleFile(path.join(dir, 'b.ts')), /owned publication failure/);
    } else if (mode === 'full-failure') {
      store.addEdge = () => { throw Error('owned full extraction failure'); };
      assert.throws(() => analyzer.analyzeProject(), /owned full extraction failure/);
    } else if (mode === 'shared') {
      await (async () => {
        const snapshot = analyzer.createProgram();
        analyzer.analyzeSingleFile(path.join(dir, 'a.ts'), snapshot);
        await gc();
        assert.equal(references[0].program.deref(), snapshot, 'caller must still own its shared snapshot');
        analyzer.analyzeSingleFile(path.join(dir, 'b.ts'), snapshot);
      })();
      assert.equal(references.length, 1);
    } else if (mode === 'repeat') {
      for (let i = 0; i < 3; i++) { analyzer.analyzeProject(); await gc(); }
    } else throw Error(`Unknown mode ${mode}`);
    // Cross event-loop jobs so WeakRef's keep-alive rule does not invalidate the check.
    await gc();
    for (const [i, refs] of references.entries()) for (const [kind, ref] of Object.entries(refs)) {
      assert.equal(ref.deref(), undefined, `compiler ${kind} ${i} retained after ${mode}`);
    }
    const graph = store.getGraph();
    if (['full', 'single', 'shared', 'repeat'].includes(mode)) {
      assert(graph.nodes.has('func:b.ts:caller'));
      assert(store.getEdgesTo('func:a.ts:target').some(edge => edge.type === 'CALLS'));
    }
    if (['missing', 'checker-failure', 'publish-failure'].includes(mode)) assert.equal(graph.nodes.size, 0);
    console.log(JSON.stringify({ mode, snapshots: references.length, collected: true, nodes: graph.nodes.size, edges: graph.edges.length }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { loadAnalyzer };
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
