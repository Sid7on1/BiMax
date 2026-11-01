#!/usr/bin/env node
// Local component timings only. Frozen working-tree baseline, paired ABBA order, no discarded samples.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { performance } = require('perf_hooks');
const { createHash } = require('crypto');
const root = path.resolve(__dirname, '..');
const evidence = path.resolve(process.argv[2] || path.join(root, 'docs/product-reset/evidence/2026-10-13-context-orchestration'));
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-perf-'));
process.env.BIMAX_STATE_DIR = path.join(state, 'state');
process.env.BIMAX_BREAKGLASS_DIR = path.join(state, 'breakglass');
require('tsx/cjs');
const sourcePath = path.join(root, 'src/memory/context.manager.ts');
const sources = { baseline: fs.readFileSync(path.join(evidence, 'baseline/src/memory/context.manager.ts'), 'utf8'), current: fs.readFileSync(sourcePath, 'utf8') };
function load(source) {
  const mod = new Module(sourcePath);
  mod.filename = sourcePath;
  mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  mod._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, sourcePath);
  return mod.exports;
}
const versions = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, load(source)]));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const shapes = [
  { name: 'summary-small', messages: 5, chars: 10, limit: 96000, repeats: 2000 },
  { name: 'summary-oversized-400', messages: 400, chars: 500, limit: 20000, repeats: 80 },
  { name: 'summary-oversized-2000', messages: 2000, chars: 500, limit: 96000, repeats: 20 },
];
const results = [];
for (const shape of shapes) {
  const messages = Array.from({ length: shape.messages }, (_, i) => ({ role: 'user', content: `m${i} ${'x'.repeat(shape.chars)}` }));
  const funcs = Object.fromEntries(Object.entries(versions).map(([name, version]) => [name, () => version.boundSummaryInput(messages, shape.limit)]));
  for (const [name, fn] of Object.entries(funcs)) {
    const text = fn();
    if (text.length > shape.limit || !text.includes('m0 ') || !text.includes(`m${shape.messages - 1} `)) throw new Error(`${name} failed ${shape.name}`);
    JSON.parse(text);
    for (let i = 0; i < 20; i++) fn();
  }
  results.push(sample(shape.name, funcs, shape.repeats));
}
for (const shape of [{ name: 'warm-text-cache', calls: false, chars: 128 }, { name: 'warm-tool-cache-small', calls: true, chars: 128 }, { name: 'warm-tool-cache-large-args', calls: true, chars: 4096 }]) {
  const messages = Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', content: `work ${i}`, ...(shape.calls ? { tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ text: 'x'.repeat(shape.chars) }) } }] } : {}) }));
  const managers = Object.fromEntries(Object.entries(versions).map(([name, v]) => [name, new v.ContextManager({ async *chat() {} })]));
  const expected = managers.baseline.requestTokens(messages);
  if (managers.current.requestTokens(messages) !== expected) throw new Error('request accounting changed for immutable messages');
  const funcs = Object.fromEntries(Object.entries(managers).map(([name, manager]) => [name, () => manager.requestTokens(messages)]));
  results.push(sample(shape.name, funcs, 500));
}
function sample(name, funcs, repeats) {
  const samples = [];
  let checksum = 0;
  for (let pair = 0; pair < 9; pair++) {
    const order = pair % 2 ? ['current', 'baseline', 'baseline', 'current'] : ['baseline', 'current', 'current', 'baseline'];
    for (const version of order) {
      const before = performance.now();
      for (let i = 0; i < repeats; i++) { const out = funcs[version](); checksum += typeof out === 'string' ? out.length : out; }
      samples.push({ pair, version, msPerCall: (performance.now() - before) / repeats });
    }
  }
  return { name, repeats, samples, checksum, baselineMedianMs: median(samples.filter(s => s.version === 'baseline').map(s => s.msPerCall)), currentMedianMs: median(samples.filter(s => s.version === 'current').map(s => s.msPerCall)), discarded: 0 };
}
const record = { scope: 'Node local component fixtures, not installed app/provider latency', runtime: process.version, machine: { model: os.cpus()[0].model, cores: os.cpus().length, memoryBytes: os.totalmem() }, sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, createHash('sha256').update(s).digest('hex')])), results };
fs.writeFileSync(path.join(evidence, process.argv[3] || 'component-timings.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
for (const result of results) process.stdout.write(`${result.name}: ${result.baselineMedianMs.toFixed(6)} -> ${result.currentMedianMs.toFixed(6)} ms/call\n`);
fs.rmSync(state, { recursive: true, force: true });
