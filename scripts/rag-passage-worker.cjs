// Isolated real memory RAG. Answers/labels never enter this worker or its indexes.
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const { createHash } = require('crypto'), readline = require('readline');
const root = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-public-rag-'));
process.env.BIMAX_STATE_DIR = path.join(temp, 'state'); process.env.BIMAX_BREAKGLASS_DIR = path.join(temp, 'breakglass');
process.env.BIMAX_RECENCY_FLUSH_MS = '3600000';
const { Logger } = require('../dist/utils/logger'); Logger.info = () => {}; Logger.warn = () => {};
const recalls = {};
const { DatabaseSync } = require('node:sqlite');
const {writeBatch}=require('./lib/rag_vector_cache.cjs');
const cachePath = '/Users/vishsiddharth/Library/Caches/BimaxBench/rag-evidence-20261014/fresh50-embeddings.sqlite';
const cache = new DatabaseSync(cachePath);
const seed = new DatabaseSync('/Users/vishsiddharth/Library/Caches/BimaxBench/rag-evidence-20261014/embeddings-checkpoint-1.sqlite', {readOnly:true});
const seedRead=seed.prepare('SELECT vector,truncated FROM vectors WHERE key=?');
cache.exec('PRAGMA busy_timeout=30000');
cache.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector TEXT NOT NULL, truncated INTEGER NOT NULL)');
const cacheRead = cache.prepare('SELECT vector,truncated FROM vectors WHERE key=?');
const cacheWrite = cache.prepare('INSERT OR IGNORE INTO vectors VALUES(?,?,?)');
let cacheHits=0,cacheMisses=0;
const { chunkDocument } = require('../dist/memory/chunking');
const { normalize } = require('../dist/memory/embeddings');
const hash = text => createHash('sha256').update(text).digest('hex');
const versions = {};
for (const version of ['baseline', 'current']) {
  const filename = path.join(root, 'dist/memory/vector.store.js');
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(path.join(out, 'compiled', `${version}.js`), 'utf8'), filename);
  versions[version] = mod.exports.VectorStore;
  const recallFile = path.join(root, 'dist/memory/recall.js');
  const recallModule = new Module(recallFile); recallModule.filename = recallFile; recallModule.paths = Module._nodeModulePaths(path.dirname(recallFile));
  recallModule._compile(fs.readFileSync(path.join(out, 'compiled', `recall-${version}.js`), 'utf8'), recallFile);
  recalls[version] = recallModule.exports.recallForTurn;
}
let stores = {}, originals = new Map(), embedded = new Map(), modelDigest = '', corpusSerial = 0;
let embeddingObservations = [];
const backend = { get id() { return `ollama:all-minilm:${modelDigest}:384`; }, dimensions: 384,
  async embed(texts, role) {
    let cached=0,potentiallyTruncated=0;
    for (const text of new Set(texts)) if (!embedded.has(text)) {
      const key=`${modelDigest}:${role}:${hash(text)}`;
      const row=cacheRead.get(key)||seedRead.get(key);
      if (row) {
        const vector=JSON.parse(row.vector);
        if (vector.length!==384 || !vector.every(Number.isFinite) || !vector.some(x=>x!==0)) throw new Error('Invalid cached real embedding');
        embedded.set(text,vector);cached++;potentiallyTruncated+=row.truncated;cacheHits++;
      }
    }
    if(cached) embeddingObservations.push({role,cacheHit:true,inputs:cached,potentiallyTruncatedInputs:potentiallyTruncated,requiredProviderTruncation:false,truncationAffectedInputsBound:[0,0]});
    const missing = [...new Set(texts.filter(text => !embedded.has(text)))]; cacheMisses+=missing.length;
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      const call = truncate => fetch('http://localhost:11434/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'all-minilm:latest', input: batch, truncate, keep_alive: '30s', options: {num_gpu:0,num_thread:1} }), signal: AbortSignal.timeout(90000) });
      let response = await call(false), truncated = false;
      if (!response.ok) {
        const error = await response.text();
        if (response.status !== 400 || !error.includes('input length exceeds the context length')) throw new Error(`embedding HTTP ${response.status}: ${error}`);
        truncated = true; response = await call(true);
      }
      if (!response.ok) throw new Error(`embedding HTTP ${response.status}: ${await response.text()}`);
      const data = await response.json();
      embeddingObservations.push({ role, inputs: batch.length, inputChars: batch.reduce((n, text) => n + text.length, 0),
        maxInputChars: Math.max(...batch.map(text => text.length)), requiredProviderTruncation: truncated, promptTokens: data.prompt_eval_count,
        truncationAffectedInputsBound: truncated ? [1, batch.length] : [0, 0] });
      if (data.embeddings?.length !== batch.length) throw new Error('incomplete embedding batch');
      const pendingRows=[];
      data.embeddings.forEach((vector, at) => {
        if (vector.length !== 384 || !vector.every(Number.isFinite) || !vector.some(value=>value!==0)) throw new Error('invalid embedding space');
        const normalized=normalize(vector); embedded.set(batch[at], normalized);
        pendingRows.push([`${modelDigest}:${role}:${hash(batch[at])}`,JSON.stringify(normalized),truncated?1:0]);
      });
      writeBatch(cache,cacheWrite,pendingRows);
    }
    return texts.map(text => embedded.get(text));
  } };
function dispose() {
  for (const store of Object.values(stores)) clearTimeout(store.recencyTimer);
  stores = {}; originals.clear(); embedded.clear(); embeddingObservations = [];
}
async function dispatch(input) {
  if (input.op === 'load') {
    dispose();
    const started = performance.now();
    const tags = await (await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) })).json();
    const model = tags.models.find(model => model.name === 'all-minilm:latest');
    if (!model?.digest) throw new Error('required real embedding model absent');
    if (modelDigest && modelDigest !== model.digest) throw new Error('embedding model changed during run');
    modelDigest = model.digest;
    const docs = input.documents.map(doc => ({ id: doc.id, metadata: { content: doc.text, tags: [] }, chunks: chunkDocument(doc.id, doc.text) }));
    originals = new Map(docs.map(doc => [doc.id, doc.metadata.content]));
    const chunks = docs.flatMap(doc => doc.chunks);
    await backend.embed(chunks.map(chunk => chunk.text), 'passage');
    for (const chunk of chunks) { chunk.embedding = embedded.get(chunk.text); chunk.space = backend.id; }
    const json = JSON.stringify(docs);
    for (const version of ['baseline', 'current']) {
      const storePath = path.join(temp, `${version}.json`); fs.writeFileSync(storePath, json);
      stores[version] = new versions[version](backend, null, { storePath, maxVectors: Math.max(500, docs.length), dedup: false });
      await stores[version].semanticSearch('initializationnomatch', 1, 0, { mode: 'lexical' });
    }
    corpusSerial++;
    return { corpusSerial, documents: docs.length, chunks: chunks.length, ingestionMs: performance.now() - started,
      embedding: backend.id, embeddingObservations, stats: stores.current.stats(), execution:{embeddingWorkerConcurrency:1,batchSize:16,num_gpu:0,num_thread:1,keep_alive:'30s',cacheTransaction:'one per fresh embedding batch',seedReadOnly:true}, inputSha256: hash(JSON.stringify(input.documents)), rss: process.memoryUsage().rss, embeddingCache:{hits:cacheHits,misses:cacheMisses,format:'exact normalized JSON vectors, model-digest/role/text-SHA keyed, batch truncation conservative flag'} };
  }
  if (input.op === 'query') {
    const observationAt = embeddingObservations.length;
    const started = performance.now(); await backend.embed([input.query], 'query');
    const queryEmbeddingMs = performance.now() - started;
    const responses = {};
    for (const version of corpusSerial % 2 ? ['baseline', 'current'] : ['current', 'baseline']) {
      let hits = [];
      const store = stores[version];
      const seam = { semanticSearch: async (...args) => { hits = await store.semanticSearch(...args); return hits; },
        unknownTerms: (...args) => store.unknownTerms(...args), lastSearchMode: () => store.lastSearchMode() };
      const start = performance.now();
      const recalled = await recalls[version](seam, input.query, version === 'baseline' ? {limit:3,maxChars:1800} : {limit:3});
      const provenance = (recalled?.evidence ?? []).every(span => {
        const id = span.locator.documentId, original = originals.get(id);
        // Production chunk assembly can insert whitespace between structural pieces.
        // Require the same ordered source text modulo whitespace, plus exact source version and shown span.
        return original !== undefined && recalled.text.includes(span.text)
          && original.replace(/\s+/g, ' ').includes(span.text.replace(/\s+/g, ' '))
          && span.sourceId === `memory:${id}` && span.sourceVersion === `sha256:${hash(original)}`;
      });
      if (!provenance) throw new Error('evidence provenance failed');
      responses[version] = { ids: recalled?.ids ?? [], prompt: recalled?.text ?? '', evidence: recalled?.evidence ?? [],
        sourceIds: hits.map(doc => doc.id), mode: store.lastSearchMode(), recallSkipped: hits.length === 0,
        wallMs: performance.now() - start, provenance };
    }
    const same = JSON.stringify(responses.baseline.ids) === JSON.stringify(responses.current.ids)
      && responses.baseline.prompt === responses.current.prompt;
    const sameSources=JSON.stringify(responses.baseline.sourceIds)===JSON.stringify(responses.current.sourceIds);
    if (!sameSources) throw new Error('Passage-only change altered retrieved document ranking');
    return { same, sameSources, queryEmbeddingMs, queryEmbeddingObservations: embeddingObservations.slice(observationAt), ...responses };
  }
  if (input.op === 'close') { dispose(); fs.rmSync(temp, { recursive: true, force: true }); cache.close(); seed.close(); return { closed: true }; }
  throw new Error('unknown operation');
}
const lines = readline.createInterface({ input: process.stdin });
(async () => {
  for await (const line of lines) {
    try { process.stdout.write(JSON.stringify({ ok: true, value: await dispatch(JSON.parse(line)) }) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error.message) }) + '\n'); }
  }
  dispose(); fs.rmSync(temp, { recursive: true, force: true });
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
