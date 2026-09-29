import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The monolith's engine transport (record 64, M1): the engine as a worker thread inside the app's process. These run a
 * small stand-in engine as a REAL worker thread through spawnEngineWorker and check the supervisor contract — what the
 * engine is told, NDJSON both ways, a clean shutdown, an engine crash, and a stuck engine.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-engine-worker-')));
jest.mock('electron', () => ({ app: { getPath: () => tmp, isPackaged: false }, utilityProcess: {} }));

import { ENGINE_WORKER_HEAP_MB, engineTransport, spawnEngineWorker } from '../main/engine';
import { MAX_LIVE_ENGINES } from '../main/thread.manager';

const fakeEngine = path.join(tmp, 'fake-engine.cjs');
fs.writeFileSync(fakeEngine, `
const { workerData } = require('node:worker_threads');
const v8 = require('node:v8');
const port = workerData.bimaxEnginePort;
let acked = 0;
const say = (m) => port.postMessage(JSON.stringify(m));
say({ t: 'ready', root: workerData.bimaxEngineRoot, module: process.env.BIMAX_ENGINE_MODULE,
      heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576) });
process.stdout.write('a log line, never protocol\\n');
port.on('message', (m) => {
  if (m.t === '__ack') { acked += m.bytes; return; }
  if (m.t === 'ping') say({ t: 'pong', id: m.id });
  if (m.t === 'burst') for (let i = 0; i < m.n; i++) say({ t: 'event', name: 'status', args: ['x'.repeat(100)] });
  if (m.t === 'acked?') say({ t: 'acked', bytes: acked });
  if (m.t === 'crash') setTimeout(() => { throw new Error('the engine blew up'); });
  if (m.t === 'spin') { for (;;) { /* stuck */ } }
});
port.on('close', () => { process.exit(0); });
`);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function start() {
  const messages: Array<Record<string, unknown>> = [];
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => { resolveExit = r; });
  const errors: Error[] = [];
  const handle = spawnEngineWorker(path.join(tmp, 'project'), { X_TEST: '1' }, {
    onMessage: (m) => messages.push(m),
    onMalformed: () => undefined,
    onExit: (code) => resolveExit(code),
    onError: (e) => errors.push(e),
  }, fakeEngine);
  const until = async (t: string) => {
    for (let i = 0; i < 200 && !messages.some((m) => m.t === t); i++) await new Promise((r) => setTimeout(r, 25));
    return messages.find((m) => m.t === t);
  };
  return { handle, messages, exited, errors, until };
}

test('the engine is told its folder and its own bundle, and messages travel over the port both ways', async () => {
  const e = start();
  const ready = await e.until('ready');
  expect(ready).toEqual(expect.objectContaining({ root: path.join(tmp, 'project'), module: fakeEngine }));
  e.handle.send({ t: 'ping', id: 7 });
  expect(await e.until('pong')).toEqual({ t: 'pong', id: 7 });
  e.handle.endStdin();
  e.handle.kill('SIGTERM');
  expect(await e.exited).toBe(0); // closing the port let it shut itself down; it was not terminated
  expect(fs.readFileSync(path.join(tmp, 'engine.log'), 'utf8')).toContain('a log line, never protocol');
}, 20_000);

test('the engine runs under its heap limit, a memory share of the process', async () => {
  const e = start();
  const ready = await e.until('ready');
  expect(Number(ready!.heapLimitMb)).toBeLessThanOrEqual(ENGINE_WORKER_HEAP_MB + 64);
  expect(MAX_LIVE_ENGINES * ENGINE_WORKER_HEAP_MB).toBeLessThanOrEqual(3 * 1024); // room left in the shared 4 GB
  e.handle.kill('SIGKILL');
  await e.exited;
}, 20_000);

test('an uncaught exception in the engine is reported with its message and ends only that worker', async () => {
  const e = start();
  await e.until('ready');
  e.handle.send({ t: 'crash' });
  expect(await e.exited).toBe(1);
  expect(e.errors.map((x) => x.message)).toEqual(['the engine blew up']);
  expect(fs.readFileSync(path.join(tmp, 'engine.log'), 'utf8')).toContain('engine worker error');
}, 20_000);

test('a stuck engine is stopped: SIGKILL at once, SIGTERM after the grace period', async () => {
  const a = start();
  await a.until('ready');
  a.handle.send({ t: 'spin' });
  await new Promise((r) => setTimeout(r, 100));
  a.handle.kill('SIGKILL');
  expect(await a.exited).toBe(1);

  const b = start();
  await b.until('ready');
  b.handle.send({ t: 'spin' });
  const t0 = Date.now();
  b.handle.endStdin();
  b.handle.kill('SIGTERM');
  expect(await b.exited).toBe(1);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
}, 30_000);

test('the worker thread is the default transport (M2); the separate process stays selectable for one release', () => {
  expect(engineTransport({})).toBe('worker');
  expect(engineTransport({ BIMAX_ENGINE_TRANSPORT: '' })).toBe('worker');
  expect(engineTransport({ BIMAX_ENGINE_TRANSPORT: 'worker' })).toBe('worker');
  expect(engineTransport({ BIMAX_ENGINE_TRANSPORT: 'process' })).toBe('process');
  expect(engineTransport({ BIMAX_ENGINE_TRANSPORT: ' Utility ' })).toBe('process');
  expect(engineTransport({ BIMAX_ENGINE_TRANSPORT: 'child' })).toBe('child');
});

test('the app acknowledges the output it handled, so the engine may send more', async () => {
  const e = start();
  await e.until('ready');
  e.handle.send({ t: 'burst', n: 50 });
  for (let i = 0; i < 200 && e.messages.filter((m) => m.t === 'event').length < 50; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30)); // the end-of-tick acknowledgement
  e.handle.send({ t: 'acked?' });
  const acked = await e.until('acked');
  const handled = e.messages.filter((m) => m.t !== 'acked').reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  expect(Number(acked!.bytes)).toBe(handled);
  e.handle.kill('SIGKILL');
  await e.exited;
}, 20_000);
