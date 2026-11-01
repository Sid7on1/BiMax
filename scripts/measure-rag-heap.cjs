#!/usr/bin/env node
// Production JS dependency graph in fresh children; no TypeScript compiler in measured processes.
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const { createHash } = require('crypto');
const root = path.resolve(__dirname, '..');
if (process.argv[2] === '--child') {
  const [out, version, run] = process.argv.slice(3);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-rag-heap-'));
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state'); process.env.BIMAX_BREAKGLASS_DIR = path.join(temp, 'breakglass');
  process.env.BIMAX_RECENCY_FLUSH_MS = '3600000';
  const { Logger } = require('../dist/utils/logger'); Logger.info = () => {}; Logger.warn = () => {};
  const filename = path.join(root, 'dist/memory/vector.store.js');
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(path.join(out, 'compiled', `${version}.js`), 'utf8'), filename);
  const { VectorStore } = mod.exports;
  const fixture = count => [{ id: 'large', metadata: { content: Array.from({ length: count }, (_, i) => `vocabulary${i} background`).join('\n'), tags: [] },
    chunks: Array.from({ length: count }, (_, i) => ({ id: `large#${i}`, text: `vocabulary${i} background` })) }];
  async function create(count, file) {
    fs.writeFileSync(file, JSON.stringify(fixture(count)));
    const store = new VectorStore(null, null, { storePath: file });
    await store.semanticSearch(`vocabulary${count - 1}`, 1, 0);
    return store;
  }
  (async () => {
    let warm = await create(100, path.join(temp, 'warm.json'));
    for (let i = 0; i < 20; i++) await warm.semanticSearch('vocabulary99', 1, 0);
    clearTimeout(warm.recencyTimer); warm = null;
    fs.writeFileSync(path.join(temp, 'large.json'), JSON.stringify(fixture(10000)));
    global.gc(); global.gc(); const before = process.memoryUsage();
    const store = new VectorStore(null, null, { storePath: path.join(temp, 'large.json') });
    for (let i = 0; i < 5; i++) await store.semanticSearch('vocabulary9999', 1, 0);
    global.gc(); global.gc(); const after = process.memoryUsage();
    const record = { version, run: Number(run), chunks: 10000, before, after, retainedBytes: after.heapUsed - before.heapUsed,
      peakRssKiB: process.resourceUsage().maxRSS, stats: store.stats() };
    fs.writeFileSync(path.join(out, `compiled-heap-${version}-${run}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    clearTimeout(store.recencyTimer); fs.rmSync(temp, { recursive: true, force: true });
  })().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
} else {
  const { spawnSync } = require('child_process'), ts = require('typescript');
  const out = path.resolve(process.argv[2]); fs.mkdirSync(path.join(out, 'compiled'), { recursive: true });
  const sourceHashes = {};
  for (const version of ['legacy', 'baseline', 'current']) {
    const file = version === 'current' ? path.join(root, 'src/memory/vector.store.ts') : path.join(out, version === 'legacy' ? 'legacy' : 'baseline', 'src/memory/vector.store.ts');
    const source = fs.readFileSync(file, 'utf8'); sourceHashes[version] = createHash('sha256').update(source).digest('hex');
    fs.writeFileSync(path.join(out, 'compiled', `${version}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
  }
  for (let run = 0; run < 5; run++) for (const version of run % 2 ? ['current', 'baseline', 'legacy'] : ['legacy', 'baseline', 'current']) {
    const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', out, version, String(run)], { encoding: 'utf8' });
    fs.writeFileSync(path.join(out, `compiled-heap-${version}-${run}.log`), result.stdout + result.stderr, { flag: 'wx' });
    if (result.status !== 0) throw new Error(`Heap child failed: ${version}/${run}`);
    process.stdout.write(`heap ${version}/${run} passed\n`);
  }
  fs.writeFileSync(path.join(out, 'compiled-heap-sources.json'), JSON.stringify(sourceHashes, null, 2) + '\n', { flag: 'wx' });
}
