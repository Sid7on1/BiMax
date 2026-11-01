// Real worker/process fixture; compile current TypeScript on demand without loading a model.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { parentPort, workerData } = require('node:worker_threads');
const root = process.env.BIMAX_TEST_SOURCE_ROOT || path.resolve(__dirname, '../../..');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, file);
const send = value => parentPort ? parentPort.postMessage(value) : process.send(value);
const listen = fn => parentPort ? parentPort.on('message', fn) : process.on('message', fn);
const input = workerData || JSON.parse(process.env.BIMAX_MEMORY_TEST_CONFIG);
process.env.BIMAX_STATE_DIR = path.dirname(input.file);
const { VectorStore } = require(path.join(root, 'src/memory/vector.store.ts'));
const store = new VectorStore(null, null, { storePath: input.file, dedup: false });
let release;
const save = store.saveStore.bind(store);
store.saveStore = async () => {
  send({ type: 'at-save' });
  await new Promise(r => { release = r; });
  await save();
};
listen(async message => {
  if (message === 'release') { release?.(); return; }
  if (message !== 'start') return;
  send({ type: 'started' });
  try {
    await store.storeDocument(input.id, `Unique ${input.id} observation.`, ['note']);
    send({ type: 'done' });
  } catch (error) { send({ type: 'error', error: String(error) }); }
});
store.semanticSearch('initialize').then(() => send({ type: 'ready' })).catch(error => send({ type: 'error', error: String(error) }));
