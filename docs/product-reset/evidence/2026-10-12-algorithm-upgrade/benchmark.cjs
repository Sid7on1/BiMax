// Run from the repository root: node --expose-gc .../benchmark.cjs > .../benchmark.json
// No providers, product config, GUI, or dependencies beyond the installed TypeScript compiler.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');
const baseline = path.join(__dirname, 'baseline');
const hash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
function load(file) {
  const source = fs.readFileSync(file, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'require', code)(exports, require);
  return exports;
}
function pair(name, before, after, repetitions = 11) {
  assert.deepEqual(after(), before(), name + ' end state differs');
  for (let i = 0; i < 4; i++) { before(); after(); }
  const times = { before: [], after: [] };
  let output;
  for (let i = 0; i < repetitions; i++) {
    for (const side of i % 2 ? ['after', 'before'] : ['before', 'after']) {
      global.gc?.();
      const start = performance.now();
      output = (side === 'before' ? before : after)();
      times[side].push(performance.now() - start);
    }
  }
  const stats = values => {
    const sorted = [...values].sort((a,b) => a-b);
    return { p50_ms: sorted[Math.floor(sorted.length / 2)], p95_ms: sorted[Math.ceil(sorted.length * .95) - 1], raw_ms: values };
  };
  return { name, repetitions, discard_count: 0, before: stats(times.before), after: stats(times.after), correctness_sha256: hash(output) };
}
const oldBm = load(path.join(baseline, 'src/memory/bm25.ts')).Bm25Index;
const newBm = load('src/memory/bm25.ts').Bm25Index;
const TopK = load('src/utils/bounded.top.k.ts').BoundedTopK;
const oldBreaker = load(path.join(baseline, 'src/core/circuit-breaker.ts'));
const newBreaker = load('src/core/circuit-breaker.ts');
const oldCache = load(path.join(baseline, 'src/memory/file-state-cache.ts')).FileStateCache;
const newCache = load('src/memory/file-state-cache.ts').FileStateCache;
const results = [];
for (const n of [100, 1000, 10_000]) {
  const docs = Array.from({length:n}, (_,i) => ({id:`d${i}`,text:`common repository coding memory token${i} ${i % 50 === 0 ? 'needle exactSymbol' : 'ordinary filler'}`}));
  const a = new oldBm(docs), b = new newBm(docs);
  for (const query of ['needle exactSymbol', 'common', 'notpresent']) {
    results.push(pair(`bm25 N=${n} query=${query}`, () => a.search(query), () => b.search(query)));
  }
  results.push(pair(`bm25 build N=${n}`, () => new oldBm(docs).size, () => new newBm(docs).size));
}
function random(seed) { return () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed / 2**32; }; }
for (const n of [100, 1000, 10_000, 100_000]) {
  const rng = random(16);
  const input = Array.from({length:n}, (_,i) => ({id:`d${i}`,score:rng(),used:i%3}));
  const cmp = (a,b) => b.score-a.score || b.used-a.used || a.id.localeCompare(b.id);
  for (const order of ['random','ascending','descending','tied']) {
    const values = order === 'ascending' ? [...input].sort((a,b) => a.score-b.score) : order === 'descending' ? [...input].sort(cmp) : order === 'tied' ? input.map(v=>({...v,score:1})) : input;
    let peakRetained=0, heapComparisons=0, sortComparisons=0;
    const exact = [...values].sort((a,b)=>{sortComparisons++;return cmp(a,b);}).slice(0,64);
    const heap = new TopK(64, (a,b)=>{heapComparisons++;return cmp(a,b);});
    for(const v of values) {heap.add(v);peakRetained=Math.max(peakRetained,heap.size);}
    assert.deepEqual(heap.sorted(),exact);
    const record = pair(`top-k N=${n} k=64 order=${order}`, () => [...values].sort(cmp).slice(0,64), () => { const h = new TopK(64,cmp);for(const v of values)h.add(v);return h.sorted(); });
    record.operation_counts = { peak_retained_scores_before:n, peak_retained_scores_after:peakRetained, sort_comparisons:sortComparisons, heap_comparisons:heapComparisons };
    results.push(record);
  }
}
for (const n of [100, 10_000, 100_000]) {
  function run(module) {
    let now=0;
    const breaker=new module.CircuitBreaker({...module.serverConfig(),minSamples:20_000,windowDurationMs:1000},{clock:()=>now});
    for(let i=0;i<n;i++)breaker.record(i%7<3?module.Outcome.Failure:module.Outcome.Success);
    const rate=breaker.errorRate();now=1000;const boundary=breaker.errorRate();now=1001;const expired=breaker.errorRate();
    return { rate,boundary,expired,state:breaker.state() };
  }
  results.push(pair(`breaker N=${n} cap=10000`,()=>run(oldBreaker),()=>run(newBreaker)));
}
for (const n of [100, 10_000]) {
  function run(Type) {
    const cache=new Type();
    for(let i=0;i<100;i++)cache.set(`/fixture/${i}`,1,`body${i}`);
    let checksum=0;
    for(let i=0;i<n;i++)checksum+=(cache.get(`/fixture/${i%100}`,1)||'').length;
    cache.set('/fixture/new',1,'new');
    return {checksum,rows:cache.getRecentReads(),evicted:cache.get('/fixture/0',1)};
  }
  results.push(pair(`file-cache N=${n} cap=100`,()=>run(oldCache),()=>run(newCache)));
}
console.log(JSON.stringify({ schema:1,kind:'paired component microbenchmarks; not installed-user-task latency, quality, energy or competitive proof',machine:{platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model,cores:os.cpus().length,memory_bytes:os.totalmem(),node:process.version},warmups:4,ordering:'alternating AB/BA; explicit GC before each timed side; no parallel tests',results },null,2));
