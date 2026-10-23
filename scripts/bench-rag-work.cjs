#!/usr/bin/env node
// Local memory-RAG fixtures. No model answers, paid endpoints or public-benchmark claims.
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const ts = require('typescript'), { performance } = require('perf_hooks'), { createHash } = require('crypto');
const { gradeEvidence, passes } = require('./lib/rag-fixture-grader.cjs');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs/product-reset/evidence/2026-10-14-rag'));
const name = process.argv[3] || 'run.json';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-rag-bench-'));
process.env.BIMAX_STATE_DIR = path.join(temp, 'state'); process.env.BIMAX_BREAKGLASS_DIR = path.join(temp, 'breakglass');
process.env.BIMAX_RECENCY_FLUSH_MS = '3600000'; // no persistence timer inside measurements
require('tsx/cjs');
// Suppress fixture diagnostics, never benchmark errors.
const logger = require('../src/utils/logger');
if (logger.Logger) for (const method of ['info', 'debug', 'warn']) logger.Logger[method] = () => {};
const versions = {}, hashes = {}, results = [], quality = [];
for (const version of ['baseline', 'current']) {
  versions[version] = {};
  for (const relative of ['src/memory/vector.store.ts', 'src/memory/recall.ts']) {
    const filename = path.join(root, relative);
    const source = fs.readFileSync(version === 'baseline' ? path.join(out, 'baseline', relative) : filename, 'utf8');
    hashes[`${version}:${relative}`] = createHash('sha256').update(source).digest('hex');
    const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
    Object.assign(versions[version], mod.exports);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const vector = { id: 'controlled-fixture-space', dimensions: 2, embed: async texts => texts.map(() => [1, 0]) };
let serial = 0;
function document(id, lines, tags = [], embedding) {
  return { id, metadata: { content: lines.join('\n'), tags }, chunks: lines.map((text, i) => ({
    id: `${id}#${i}`, text, ...(embedding ? { embedding, space: vector.id } : {}),
  })) };
}
async function stores(docs, dense = false) {
  const pair = {};
  for (const version of ['baseline', 'current']) {
    const storePath = path.join(temp, `${serial++}.json`); fs.writeFileSync(storePath, JSON.stringify(docs));
    pair[version] = new versions[version].VectorStore(dense ? vector : null, null, { storePath, maxVectors: Math.max(500, docs.length), dedup: false });
    await pair[version].semanticSearch('initializationnomatch', 1, 0, { mode: 'lexical' });
  }
  return pair;
}
async function sample(label, funcs, repeats) {
  const before = await funcs.baseline(), after = await funcs.current();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Equivalence failed: ${label}`);
  for (const version of ['baseline', 'current']) for (let i = 0; i < 8; i++) await funcs[version]();
  const samples = []; let checksum = 0;
  for (let group = 0; group < 9; group++) {
    for (const version of group % 2 ? ['current', 'baseline', 'baseline', 'current'] : ['baseline', 'current', 'current', 'baseline']) {
      const start = performance.now();
      for (let i = 0; i < repeats; i++) checksum += (await funcs[version]()).length;
      samples.push({ group, version, msPerCall: (performance.now() - start) / repeats });
    }
  }
  const baselineMs = median(samples.filter(s => s.version === 'baseline').map(s => s.msPerCall));
  const currentMs = median(samples.filter(s => s.version === 'current').map(s => s.msPerCall));
  results.push({ label, repeats, samples, checksum, baselineMs, currentMs, speedup: baselineMs / currentMs, reductionPercent: 100 * (1 - currentMs / baselineMs), discarded: 0 });
  process.stdout.write(`${label}: ${baselineMs.toFixed(5)} -> ${currentMs.toFixed(5)} ms; ${(baselineMs / currentMs).toFixed(2)}x\n`);
}
async function grade() {
  // Seeded generated controls and adversarial cases, not an independently collected heldout set.
  // Expected IDs/facts are grading-only; never added as query metadata or retrieval hints.
  for (const family of ['ordinary', 'document-crowding']) for (let seed = 0; seed < 8; seed++) {
    const topic = `mineralpolicy${seed}`;
    const facts = [`FACTA${seed}`, `FACTB${seed}`, `FACTC${seed}`];
    const chunks = family === 'ordinary' ? 1 : [65, 80, 100, 150, 200, 256, 300, 512][seed];
    const docs = [
      document('report', Array.from({ length: chunks }, (_, i) => `${topic} ${topic} ${topic} ${facts[0]} summary ${i}`), ['allowed'], [1, 0]),
      document('checksum', [`${topic} checksum ${facts[1]} ${'background '.repeat(family === 'ordinary' ? 0 : 60)}`], ['allowed'], [0.8, 0.6]),
      document('approval', [`${topic} approval ${facts[2]} ${'background '.repeat(family === 'ordinary' ? 0 : 60)}`], ['allowed'], [0.8, 0.6]),
      document('private', [`${topic} ${topic} ${topic} PRIVATEFORBIDDEN`], ['private', 'code'], [1, 0]),
      ...Array.from({ length: 12 + seed }, (_, i) => document(`noise${i}`, [`unrelated astronomy${i}`], ['allowed'], [0, 1])),
    ];
    for (const mode of ['lexical', 'dense', 'hybrid']) {
      const pair = await stores(docs, mode !== 'lexical');
      for (const version of ['baseline', 'current']) {
        const retrieved = await pair[version].semanticSearch(topic, 3, 0, { mode, excludeTags: ['private'], passages: true });
        // Recall has no explicit mode option: lexical uses an unavailable backend, dense/hybrid
        // cases grade the actual hybrid recall path with controlled vectors.
        const recalled = await versions[version].recallForTurn(pair[version], `${topic} summary checksum approval`, { maxChars: 900 });
        quality.push({ version, family, seed, mode, chunks, ...gradeEvidence({ docs, retrieved, recalled,
          expected: ['report', 'checksum', 'approval'], facts, forbidden: { ids: ['private'], text: ['PRIVATEFORBIDDEN'] }, maxChars: 900 }) });
      }
    }
  }
  const pair = await stores([document('current', ['quartz upload timeout is 700'], ['allowed']), document('private', ['secretpassword'], ['private'])]);
  for (const version of ['baseline', 'current']) {
    const store = pair[version];
    const missing = await versions[version].recallForTurn(store, 'What is the nebula guest wifi password?', { maxChars: 900 });
    const before = await store.semanticSearch('quartz', 1, 0);
    await store.storeDocument('current', 'quartz upload timeout is 900', ['allowed']);
    const updated = await store.semanticSearch('quartz', 1, 0);
    await store.deleteWhere(doc => doc.id === 'current');
    const deleted = await store.semanticSearch('quartz', 1, 0);
    quality.push({ version, family: 'freshness-and-abstention', missingAbstained: missing === null,
      currentValue: before[0]?.metadata.content.includes('700') && updated[0]?.metadata.content.includes('900'), deleted: deleted.length === 0 });
  }
  for (const row of quality.filter(row => row.version === 'current')) {
    if (row.family === 'freshness-and-abstention') { if (!row.missingAbstained || !row.currentValue || !row.deleted) throw new Error('Freshness/abstention failed'); }
    else if (!passes(row)) throw new Error(`Quality failed: ${JSON.stringify(row)}`);
  }
}
async function main() {
  await grade();
  for (const count of [50, 500]) {
    const docs = Array.from({ length: count }, (_, i) => document(`v${i}`, [Array.from({ length: 200 }, (_, j) => `word${i}term${j}`).join(' ')], i % 2 ? ['private'] : []));
    const pair = await stores(docs);
    for (const store of Object.values(pair)) store.unknownTerms(['notincorpus', 'missingword', 'unseenword']);
    await sample(`warm-unknown-terms-${count}-docs-200-terms`, Object.fromEntries(Object.entries(pair).map(([v, s]) => [v, () => s.unknownTerms(['notincorpus', 'missingword', 'unseenword'])])), 100);
    await sample(`warm-scoped-unknown-terms-${count}-docs`, Object.fromEntries(Object.entries(pair).map(([v, s]) => [v, () => s.unknownTerms(['notincorpus', 'missingword'], { excludeTags: ['private'] })])), 100);
  }
  for (const count of [100, 10000]) {
    const pair = await stores([document('large', [...Array.from({ length: count }, (_, i) => `background${i}`), ...Array.from({ length: 64 }, (_, i) => `needle exact passage ${i}`)])]);
    await sample(`warm-search-long-${count}-chunks`, Object.fromEntries(Object.entries(pair).map(([v, s]) => [v, async () => (await s.semanticSearch('needle', 1, 0, { passages: true })).flatMap(doc => doc.matchedChunks.map(chunk => chunk.text))])), 15);
  }
  for (const count of [50, 500, 10000]) {
    const pair = await stores(Array.from({ length: count }, (_, i) => document(`s${i}`, [i ? `background${i}` : 'uniquequery timeout is 700'])));
    await sample(`warm-sparse-search-${count}-docs`, Object.fromEntries(Object.entries(pair).map(([v, s]) => [v, async () => (await s.semanticSearch('uniquequery', 1, 0)).map(doc => doc.id)])), 30);
  }
  const pair = await stores(Array.from({ length: 500 }, (_, i) => document(`r${i}`, [i ? Array.from({ length: 200 }, (_, j) => `word${i}term${j}`).join(' ') : 'quartz upload timeout is 700'])));
  const query = 'quartz upload timeout with missingword and unseenword';
  await sample('warm-recall-500-docs-vocabulary-check', Object.fromEntries(Object.entries(pair).map(([v, s]) => [v, async () => (await versions[v].recallForTurn(s, query))?.text ?? ''])), 20);
  const control = await stores(Array.from({ length: 50 }, (_, i) => document(`c${i}`, [`quartz${i} upload timeout is 700`], [], [1, 0])), true);
  await sample('warm-dense-control-50-docs', Object.fromEntries(Object.entries(control).map(([v, s]) => [v, async () => (await s.semanticSearch('quartz0', 3, 0)).map(doc => doc.id)])), 30);
  fs.writeFileSync(path.join(out, name), JSON.stringify({ scope: 'Generated local memory RAG fixtures; controlled vectors; no model answers or independent heldout', runtime: process.version,
    platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, cores: os.cpus().length, memoryBytes: os.totalmem(), sourceHashes: hashes, quality, results }, null, 2) + '\n', { flag: 'wx' });
  fs.rmSync(temp, { recursive: true, force: true });
}
async function heap(version) {
  if (!global.gc) throw new Error('Heap mode requires --expose-gc');
  const storePath = path.join(temp, 'heap.json');
  fs.writeFileSync(storePath, JSON.stringify([document('large', Array.from({ length: 10000 }, (_, i) => `vocabulary${i} background`))]));
  global.gc(); global.gc(); const before = process.memoryUsage().heapUsed;
  const store = new versions[version].VectorStore(null, null, { storePath });
  await store.semanticSearch('vocabulary9999', 1, 0); global.gc(); global.gc();
  const after = process.memoryUsage().heapUsed;
  fs.writeFileSync(path.join(out, name), JSON.stringify({ version, chunks: 10000, before, after, retainedBytes: after - before, stats: store.stats(), sourceHashes: hashes }, null, 2) + '\n', { flag: 'wx' });
  fs.rmSync(temp, { recursive: true, force: true });
}
const run = process.argv[4]?.startsWith('heap-') ? heap(process.argv[4].slice(5)) : main();
run.catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
