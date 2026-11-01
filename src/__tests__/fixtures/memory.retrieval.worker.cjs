const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { parentPort, workerData: input } = require('node:worker_threads');
const root = process.env.BIMAX_TEST_SOURCE_ROOT || path.resolve(__dirname, '../../..');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, file);
process.env.BIMAX_STATE_DIR = path.dirname(input.file);
const { createMemoryRetrieval } = require(path.join(root, 'src/memory/retrieval.factory.ts'));
(async () => {
  let keyReads = 0;
  const retrieval = createMemoryRetrieval({ settings: input.settings, localRerank: false,
    store: { storePath: input.file, dedup: false },
    resolveChat: async () => { keyReads++; return input.chatURL ? { apiKey: 'fixture', baseURL: input.chatURL } : null; },
  });
  const before = keyReads;
  await retrieval.store.storeDocuments([
    { id: 'one', text: 'Amber launch checklist.', tags: ['note'] },
    { id: 'two', text: 'Violet launch checklist.', tags: ['note'] },
  ]);
  const docs = await retrieval.store.semanticSearch('launch checklist', 2, 0);
  parentPort.postMessage({ before, keyReads, ids: docs.map(d => d.id), mode: retrieval.store.lastSearchMode(),
    embeddingSpace: retrieval.embeddings.id });
})().catch(error => parentPort.postMessage({ error: String(error) }));
