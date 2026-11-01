// Isolated real memory RAG. Answers/labels never enter this worker or its indexes.
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const { createHash } = require('crypto'), readline = require('readline');
const root = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-public-rag-'));
process.env.BIMAX_STATE_DIR = path.join(temp, 'state'); process.env.BIMAX_BREAKGLASS_DIR = path.join(temp, 'breakglass');
process.env.BIMAX_RECENCY_FLUSH_MS = '3600000';
const { Logger } = require('../dist/utils/logger'); Logger.info = () => {}; Logger.warn = () => {};
const { recallForTurn } = require('../dist/memory/recall');
const { chunkDocument } = require('../dist/memory/chunking');
const { normalize } = require('../dist/memory/embeddings');
const hash = text => createHash('sha256').update(text).digest('hex');
const versions = {};
for (const version of ['baseline', 'current']) {
  const filename = path.join(root, 'dist/memory/vector.store.js');
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(path.join(out, 'compiled', `${version}.js`), 'utf8'), filename);
  versions[version] = mod.exports.VectorStore;
}
let stores = {}, originals = new Map(), embedded = new Map(), modelDigest = '', corpusSerial = 0;
let embeddingObservations = [];
const backend = { get id() { return `ollama:all-minilm:${modelDigest}:384`; }, dimensions: 384,
  async embed(texts, role) {
    const missing = [...new Set(texts.filter(text => !embedded.has(text)))];
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const call = truncate => fetch('http://localhost:11434/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'all-minilm:latest', input: batch, truncate, keep_alive: '10m' }), signal: AbortSignal.timeout(90000) });
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
      data.embeddings.forEach((vector, at) => {
        if (vector.length !== 384 || !vector.every(Number.isFinite)) throw new Error('invalid embedding space');
        embedded.set(batch[at], normalize(vector));
      });
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
      embedding: backend.id, embeddingObservations, stats: stores.current.stats(), inputSha256: hash(JSON.stringify(input.documents)), rss: process.memoryUsage().rss };
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
      const recalled = await recallForTurn(seam, input.query, { limit: 3, maxChars: 1800 });
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
    if (!same) throw new Error('resource optimization changed public retrieval/prompt');
    return { same, queryEmbeddingMs, queryEmbeddingObservations: embeddingObservations.slice(observationAt), ...responses };
  }
  if (input.op === 'close') { dispose(); fs.rmSync(temp, { recursive: true, force: true }); return { closed: true }; }
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
