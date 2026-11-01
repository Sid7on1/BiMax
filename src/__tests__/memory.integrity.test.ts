import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { VectorStore } from '../memory/vector.store';
import type { EmbeddingBackend } from '../memory/embeddings';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
type Fixture = Worker | ChildProcess;
function mailbox(handle: Fixture) {
  const messages: any[] = [];
  const waiting = new Set<() => void>();
  handle.on('message', message => { messages.push(message); for (const wake of waiting) wake(); });
  return {
    messages,
    wait(type: string) {
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error(`No ${type}: ${JSON.stringify(messages)}`)); }, 15_000);
        const check = () => {
          const error = messages.find(m => m.type === 'error');
          const found = messages.find(m => m.type === type);
          if (!found && !error) return;
          clearTimeout(timer); waiting.delete(check);
          if (error) reject(new Error(error.error)); else resolve(found);
        };
        waiting.add(check); check();
      });
    },
  };
}
function send(handle: Fixture, message: string) { if (handle instanceof Worker) handle.postMessage(message); else handle.send(message); }
async function stop(handle: Fixture) {
  if (handle instanceof Worker) { await handle.terminate(); return; }
  if (handle.exitCode !== null || handle.signalCode !== null) return;
  await new Promise<void>(resolve => { handle.once('exit', () => resolve()); handle.kill('SIGKILL'); });
}

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-integrity-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const disk = async (file: string): Promise<any[]> => JSON.parse(await fs.readFile(file, 'utf8'));

test.each(['worker', 'process'] as const)('%s writers retain every acknowledged independent note', async transport => {
  const file = path.join(dir, 'vectors.json');
  const entry = path.join(__dirname, 'fixtures/memory.integrity.worker.cjs');
  const create = (id: string): Fixture => transport === 'worker'
    ? new Worker(entry, { workerData: { file, id }, env: { ...process.env, BIMAX_STATE_DIR: dir } })
    : fork(entry, [], { env: { ...process.env, BIMAX_STATE_DIR: dir, BIMAX_MEMORY_TEST_CONFIG: JSON.stringify({ file, id }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const a = create('apricot'), b = create('zeppelin');
  const am = mailbox(a), bm = mailbox(b);
  try {
    await Promise.all([am.wait('ready'), bm.wait('ready')]);
    send(a, 'start'); await am.wait('at-save');
    send(b, 'start'); await bm.wait('started');
    // Both runtimes are booted. Give B time to expose an unprotected save while A owns publication.
    await new Promise(r => setTimeout(r, 120));
    const savedBeforeOwnerReleased = bm.messages.some(m => m.type === 'at-save');
    if (savedBeforeOwnerReleased) { send(b, 'release'); await bm.wait('done'); }
    send(a, 'release'); await am.wait('done');
    if (!savedBeforeOwnerReleased) { await bm.wait('at-save'); send(b, 'release'); await bm.wait('done'); }
    expect((await disk(file)).map(d => d.id).sort()).toEqual(['apricot', 'zeppelin']);
    expect(savedBeforeOwnerReleased).toBe(false);
    const reopened = new VectorStore(null, null, { storePath: file });
    expect((await reopened.semanticSearch('observation', 5, 0)).map(d => d.id).sort()).toEqual(['apricot', 'zeppelin']);
  } finally { await Promise.all([stop(a), stop(b)]); }
}, 30_000);

test.each(['worker', 'process'] as const)('%s termination releases publication ownership without a stale-lock timeout', async transport => {
  const file = path.join(dir, 'vectors.json');
  const entry = path.join(__dirname, 'fixtures/memory.integrity.worker.cjs');
  const worker: Fixture = transport === 'worker' ? new Worker(entry, {
    workerData: { file, id: 'unacknowledged' }, env: { ...process.env, BIMAX_STATE_DIR: dir },
  }) : fork(entry, [], { env: { ...process.env, BIMAX_STATE_DIR: dir,
    BIMAX_MEMORY_TEST_CONFIG: JSON.stringify({ file, id: 'unacknowledged' }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const inbox = mailbox(worker);
  try { await inbox.wait('ready'); send(worker, 'start'); await inbox.wait('at-save'); }
  finally { await stop(worker); }
  const store = new VectorStore(null, null, { storePath: file, dedup: false });
  await store.storeDocument('after-restart', 'Recovery observation.', []);
  expect((await disk(file)).map(d => d.id)).toEqual(['after-restart']);
}, 20_000);

test.each(['worker', 'process'] as const)('%s death after acknowledgement preserves its note on the next writer', async transport => {
  const file = path.join(dir, 'vectors.json');
  const entry = path.join(__dirname, 'fixtures/memory.integrity.worker.cjs');
  const holder: Fixture = transport === 'worker'
    ? new Worker(entry, { workerData: { file, id: 'acknowledged' }, env: { ...process.env, BIMAX_STATE_DIR: dir } })
    : fork(entry, [], { env: { ...process.env, BIMAX_STATE_DIR: dir, BIMAX_MEMORY_TEST_CONFIG: JSON.stringify({ file, id: 'acknowledged' }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const inbox = mailbox(holder);
  try {
    await inbox.wait('ready'); send(holder, 'start'); await inbox.wait('at-save'); send(holder, 'release'); await inbox.wait('done');
  } finally { await stop(holder); }
  const reopened = new VectorStore(null, null, { storePath: file, dedup: false });
  await reopened.storeDocument('next', 'Next independent observation.', []);
  expect((await disk(file)).map(row => row.id).sort()).toEqual(['acknowledged', 'next']);
}, 20_000);

test('failed publication cannot resurrect an unacknowledged note on the next write', async () => {
  const file = path.join(dir, 'vectors.json');
  const store = new VectorStore(null, null, { storePath: file, dedup: false });
  await store.storeDocument('retained', 'Retained observation.', []);
  const internal = store as unknown as { saveStore(): Promise<void> };
  const original = internal.saveStore.bind(store);
  internal.saveStore = async () => { throw new Error('injected disk failure'); };
  await expect(store.storeDocument('ghost', 'Unacknowledged observation.', [])).rejects.toThrow('injected disk failure');
  internal.saveStore = original;
  await store.storeDocument('new', 'New observation.', []);
  expect((await disk(file)).map(d => d.id).sort()).toEqual(['new', 'retained']);
});

test('canonical parent aliases share publication ownership', async () => {
  const real = path.join(dir, 'real'), alias = path.join(dir, 'alias');
  await fs.mkdir(real); await fs.symlink(real, alias);
  const file = path.join(real, 'vectors.json');
  const a = new VectorStore(null, null, { storePath: file, dedup: false });
  const b = new VectorStore(null, null, { storePath: path.join(alias, 'vectors.json'), dedup: false });
  await Promise.all([a.storeDocument('one', 'One independent fact.', []), b.storeDocument('two', 'Two independent facts.', [])]);
  expect((await disk(file)).map(d => d.id).sort()).toEqual(['one', 'two']);
});

test('a broken coordinator fails closed without replacing valid JSON', async () => {
  const file = path.join(dir, 'vectors.json');
  const original = '[{"id":"retained","metadata":{"content":"Retained fact.","tags":[]}}]';
  await fs.writeFile(file, original);
  await fs.writeFile(`${file}.writer.sqlite`, 'deliberately invalid SQLite');
  const store = new VectorStore(null, null, { storePath: file });
  await expect(store.storeDocument('new', 'New fact.', [])).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});

test.each(['same-instance', 'other-instance', 'deleted', 'aba'] as const)('backfill rejects a replaced generation: %s', async change => {
  const selected = deferred<void>(), result = deferred<number[][] | null>();
  let oldPending = true;
  const oldText = 'Old amber launch destination.';
  const backend: EmbeddingBackend = { id: 'integrity@2', dimensions: 2,
    embed: async texts => {
      if (oldPending) return null;
      if (texts[0] === oldText) { selected.resolve(); return result.promise; }
      return texts.map(() => [0, 1]);
    } };
  const file = path.join(dir, 'vectors.json');
  const store = new VectorStore(backend, null, { storePath: file, dedup: false });
  await store.storeDocument('mutable', oldText, []);
  oldPending = false;
  const pending = store.backfillEmbeddings();
  await selected.promise;
  const writer = change === 'same-instance' || change === 'aba' ? store
    : new VectorStore(null, null, { storePath: file, dedup: false });
  if (change === 'deleted') await writer.deleteWhere(d => d.id === 'mutable');
  else {
    await writer.storeDocument('mutable', 'New violet launch destination.', []);
    if (change === 'aba') {
      oldPending = true; await writer.storeDocument('mutable', oldText, []); oldPending = false;
    }
  }
  result.resolve([[1, 0]]);
  const observed = await pending;
  expect(observed.embedded).toBe(0);
  const rows = await disk(file);
  if (change === 'deleted') expect(rows).toEqual([]);
  else {
    expect(rows[0].metadata.content).toBe(change === 'aba' ? oldText : 'New violet launch destination.');
    expect(rows[0].chunks[0].embedding).toEqual(change === 'same-instance' ? [0, 1] : undefined);
  }
});

test('unchanged legacy chunk backfills and remains idempotent', async () => {
  const file = path.join(dir, 'vectors.json');
  await fs.writeFile(file, JSON.stringify([{ id: 'legacy', metadata: { content: 'Original retained note.', tags: [] }, chunks: [{ id: 'legacy#0', text: 'Original retained note.' }] }]));
  const backend: EmbeddingBackend = { id: 'integrity@2', dimensions: 2, embed: async texts => texts.map(() => [1, 0]) };
  const store = new VectorStore(backend, null, { storePath: file });
  expect(await store.backfillEmbeddings()).toEqual({ embedded: 1, pending: 0 });
  expect(await store.backfillEmbeddings()).toEqual({ embedded: 0, pending: 0 });
  expect((await disk(file))[0].chunks[0]).toMatchObject({ embedding: [1, 0], space: 'integrity@2' });
});

test('delayed legacy backfill rejects changed versionless source bytes', async () => {
  const file = path.join(dir, 'vectors.json');
  const rows = [{ id: 'legacy', metadata: { content: 'Old retained note.', tags: [] }, chunks: [{ id: 'legacy#0', text: 'Old retained note.' }] }];
  await fs.writeFile(file, JSON.stringify(rows));
  const selected = deferred<void>(), result = deferred<number[][] | null>();
  const backend: EmbeddingBackend = { id: 'integrity@2', dimensions: 2, embed: async () => { selected.resolve(); return result.promise; } };
  const store = new VectorStore(backend, null, { storePath: file });
  const pending = store.backfillEmbeddings(); await selected.promise;
  rows[0].metadata.content = 'New retained note.'; rows[0].chunks[0].text = 'New retained note.';
  await fs.writeFile(file, JSON.stringify(rows)); result.resolve([[1, 0]]);
  expect((await pending).embedded).toBe(0);
  expect((await disk(file))[0].chunks[0].embedding).toBeUndefined();
});

test('background recency cannot resurrect a concurrently deleted note or erase a new note', async () => {
  const previous = process.env.BIMAX_RECENCY_FLUSH_MS;
  process.env.BIMAX_RECENCY_FLUSH_MS = '30';
  const file = path.join(dir, 'vectors.json');
  try {
    const a = new VectorStore(null, null, { storePath: file, dedup: false });
    await a.storeDocument('deleted', 'Deletion checksum evidence.', []);
    await a.semanticSearch('Deletion checksum evidence', 1, 0);
    const b = new VectorStore(null, null, { storePath: file, dedup: false });
    await b.deleteWhere(row => row.id === 'deleted'); await b.storeDocument('retained', 'Retained replacement.', []);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect((await disk(file)).map(row => row.id)).toEqual(['retained']);
  } finally { if (previous === undefined) delete process.env.BIMAX_RECENCY_FLUSH_MS; else process.env.BIMAX_RECENCY_FLUSH_MS = previous; }
});
