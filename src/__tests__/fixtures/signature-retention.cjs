const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { loadAnalyzer } = require('./compiler-lifetime.cjs');
async function settle() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); } }
async function main() {
  assert.equal(typeof global.gc, 'function');
  const { StaticAnalyzer, GraphStore } = loadAnalyzer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-signature-retention-'));
  try {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
    (() => { fs.writeFileSync(path.join(dir, 'f0.ts'), `export function retained() {\n/*${'x'.repeat(8 * 1024 * 1024)}*/\nreturn 1;\n}\n`); })();
    const store = new GraphStore(':memory:'), analyzer = new StaticAnalyzer(dir, store);
    await settle(); const before = process.memoryUsage().heapUsed;
    analyzer.analyzeProject(); await settle(); const retained = process.memoryUsage().heapUsed - before;
    assert.equal(store.getNode('func:f0.ts:retained').signature, 'export function retained() {');
    assert(store.getGraph().nodes.size >= 3);
    assert(retained < 2 * 1024 * 1024, `8 MiB body retained by short signature: ${retained} bytes`);
    console.log(JSON.stringify({ retained_heap_bytes: retained, graph_nodes: store.getGraph().nodes.size }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
