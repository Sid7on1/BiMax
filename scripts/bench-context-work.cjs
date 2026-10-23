#!/usr/bin/env node
// Paired local context preparation costs. Exact output/archive equivalence gates every shape.
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const ts = require('typescript');
const { performance } = require('perf_hooks');
const { createHash } = require('crypto');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs/product-reset/evidence/2026-10-13-context-work'));
const outputName = process.argv[3] || 'timings.json';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-work-'));
process.env.BIMAX_STATE_DIR = path.join(temp, 'state'); process.env.BIMAX_BREAKGLASS_DIR = path.join(temp, 'breakglass');
require('tsx/cjs');
const paths = ['src/memory/context.manager.ts', 'src/context/continuation.ts'];
const hashes = {}, versions = {};
for (const version of ['baseline', 'current']) {
  versions[version] = {};
  for (const relative of paths) {
    const filename = path.join(root, relative);
    const source = fs.readFileSync(version === 'baseline' ? path.join(out, 'baseline', relative) : filename, 'utf8');
    hashes[`${version}:${relative}`] = createHash('sha256').update(source).digest('hex');
    const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
    Object.assign(versions[version], mod.exports);
  }
}
const noArchive = () => `archive:${'0'.repeat(32)}`;
const hashArchive = (text) => `archive:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
const histories = (count) => [
  ...Array.from({ length: count }, (_, i) => ({ role: 'user', content: `Instruction ${i}: ${'specific constraint '.repeat(12)}` })),
  ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `Tests passed for revision ${i}.` })),
  ...Array.from({ length: 6 }, (_, i) => [{ role: 'assistant', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'BashTool', arguments: JSON.stringify({ command: `npm run test-${i}` }) } }] }, { role: 'tool', tool_call_id: `c${i}`, content: 'Exit code: 0\nAll tests passed.' }]).flat(),
];
const results = [];
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
function sample(name, funcs, repeats) {
  if (funcs.baseline() !== funcs.current()) throw new Error(`Output mismatch: ${name}`);
  for (const fn of Object.values(funcs)) for (let i = 0; i < 15; i++) fn();
  const samples = []; let checksum = 0;
  for (let pair = 0; pair < 9; pair++) {
    for (const version of pair % 2 ? ['current', 'baseline', 'baseline', 'current'] : ['baseline', 'current', 'current', 'baseline']) {
      const start = performance.now();
      for (let i = 0; i < repeats; i++) { const value = funcs[version](); checksum += typeof value === 'string' ? value.length : value; }
      samples.push({ pair, version, msPerCall: (performance.now() - start) / repeats });
    }
  }
  const baselineMs = median(samples.filter(s => s.version === 'baseline').map(s => s.msPerCall));
  const currentMs = median(samples.filter(s => s.version === 'current').map(s => s.msPerCall));
  const result = { name, repeats, samples, checksum, baselineMs, currentMs, speedup: baselineMs / currentMs, reductionPercent: (1 - currentMs / baselineMs) * 100, discarded: 0 };
  results.push(result); process.stdout.write(`${name}: ${baselineMs.toFixed(6)} -> ${currentMs.toFixed(6)} ms; ${result.speedup.toFixed(2)}x; ${result.reductionPercent.toFixed(2)}% less time\n`);
}
for (const shape of [
  { name: 'summary-small-five', count: 5, size: 20, repeats: 3000 },
  { name: 'summary-uniform-400', count: 400, size: 500, repeats: 80 },
  { name: 'summary-100-KiB-read', count: 30, size: 100 * 1024, repeats: 50 },
  { name: 'summary-one-MiB-read', count: 30, size: 1024 * 1024, repeats: 10 },
  { name: 'summary-eight-MiB-read', count: 30, size: 8 * 1024 * 1024, repeats: 2 },
]) {
  const messages = Array.from({ length: shape.count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}: ${'context '.repeat(10)}` }));
  if (shape.size <= 500) for (const m of messages) m.content += 'x'.repeat(shape.size);
  else messages[10] = { role: 'tool', tool_call_id: 'read', content: 'x'.repeat(shape.size) };
  sample(shape.name, Object.fromEntries(Object.entries(versions).map(([v, lib]) => [v, () => lib.boundSummaryInput(messages, 96000)])), shape.repeats);
}
for (const shape of [{ count: 5, budget: Infinity }, { count: 500, budget: Infinity }, { count: 500, budget: 1200 }]) {
  const input = histories(shape.count);
  const funcs = {};
  const archiveBytes = {};
  for (const [v, lib] of Object.entries(versions)) {
    const state = new lib.ContinuationState(); state.absorb(input, hashArchive);
    archiveBytes[v] = []; state.render((text) => { archiveBytes[v].push(text); return hashArchive(text); }, shape.budget);
    funcs[v] = () => state.render(noArchive, shape.budget);
  }
  if (JSON.stringify(archiveBytes.baseline) !== JSON.stringify(archiveBytes.current)) throw new Error('Archive contents changed.');
  sample(`continuation-render-${shape.count}-${shape.budget}`, funcs, shape.count === 5 ? 1000 : 100);
}
for (const count of [10, 1000, 10000]) {
  const input = histories(count);
  const funcs = Object.fromEntries(Object.entries(versions).map(([v, lib]) => [v, () => { const state = new lib.ContinuationState(); state.absorb(input, noArchive); return state.render(noArchive); }]));
  sample(`continuation-absorb-${count}`, funcs, count === 10 ? 300 : count === 1000 ? 10 : 2);
}
async function fullCompaction() {
  const messages = [{ role: 'user', content: 'Keep the exact user constraint.' }, { role: 'assistant', tool_calls: [{ id: 'read', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'read', content: 'x'.repeat(1024 * 1024) }, ...Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', content: `work ${i}` }))];
  const provider = { async *chat() { yield { type: 'token', text: '## Goal\nKeep the exact user constraint.\n## Progress\nInspected source.' }; } };
  const expected = await new versions.baseline.ContextManager(provider).compact(messages);
  const actual = await new versions.current.ContextManager(provider).compact(messages);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Compaction output changed.');
  const samples = [];
  for (const v of ['baseline', 'current']) for (let i = 0; i < 5; i++) await new versions[v].ContextManager(provider).compact(messages);
  for (let pair = 0; pair < 9; pair++) for (const version of pair % 2 ? ['current', 'baseline', 'baseline', 'current'] : ['baseline', 'current', 'current', 'baseline']) {
    const start = performance.now();
    for (let i = 0; i < 5; i++) await new versions[version].ContextManager(provider).compact(messages);
    samples.push({ pair, version, msPerCall: (performance.now() - start) / 5 });
  }
  const baselineMs = median(samples.filter(s => s.version === 'baseline').map(s => s.msPerCall));
  const currentMs = median(samples.filter(s => s.version === 'current').map(s => s.msPerCall));
  results.push({ name: 'full-compaction-one-MiB-fixture-summarizer', repeats: 5, samples, baselineMs, currentMs, speedup: baselineMs / currentMs, reductionPercent: (1 - currentMs / baselineMs) * 100, discarded: 0 });
  process.stdout.write(`full compaction: ${baselineMs.toFixed(6)} -> ${currentMs.toFixed(6)} ms; ${(baselineMs / currentMs).toFixed(2)}x\n`);
}
fullCompaction().then(() => {
  fs.writeFileSync(path.join(out, outputName), JSON.stringify({ scope: 'Local generated context fixtures; full compaction uses an offline summarizer, not a model', runtime: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, cores: os.cpus().length, memoryBytes: os.totalmem(), sourceHashes: hashes, results }, null, 2) + '\n', { flag: 'wx' });
  fs.rmSync(temp, { recursive: true, force: true });
}).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
