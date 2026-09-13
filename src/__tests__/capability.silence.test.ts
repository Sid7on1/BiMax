import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { RemoteEmbeddingBackend } from '../memory/embeddings';
import { RemoteReranker } from '../memory/rerank';
import { cliEvents } from '../cli/events';
import { capabilitySnapshot, resetCapabilityStatus, reportCapability } from '../core/capability.status';
import { startStdioHost } from '../protocol/stdio.host';
import { engineReducer, initialEngineState } from '../../app/src/renderer/src/engine.state';
import { Governor } from '../governor/governor';
import { SafetyPolicy } from '../governor/policy.engine';
import { createMakeDirTool, createWriteFileTool } from '../tools/implementations/file.tool';
import { CodeIndex } from '../memory/code.index';
import { buildTool } from '../tools/tool.factory';
import { outcomeError } from '../tools/outcome';
import { outboundClass } from '../protocol/wire.queue';

const credential = { apiKey: 'private-test-key', baseURL: '' };
let server: http.Server;
let reply: { status: number; payload?: any; hang?: boolean };
let requests = 0;
let wire: any[];
let dispose: () => void;
let input: PassThrough;
let output: PassThrough;
let root: string;
let oldWorkspace: string;

beforeEach(async () => {
  resetCapabilityStatus();
  wire = []; requests = 0;
  input = new PassThrough(); output = new PassThrough();
  output.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) wire.push(JSON.parse(line)); });
  dispose = startStdioHost({ emitter: cliEvents, input, output });
  root = fs.mkdtempSync(path.join(process.cwd(), '.silence-test-'));
  oldWorkspace = SafetyPolicy.allowedWorkspace;
  SafetyPolicy.allowedWorkspace = root;
  reply = { status: 410 };
  server = http.createServer((req, res) => {
    requests++;
    req.resume();
    if (reply.hang) return;
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.payload ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  credential.baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});

afterEach(async () => {
  dispose(); input.destroy(); output.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  SafetyPolicy.allowedWorkspace = oldWorkspace;
  fs.rmSync(root, { recursive: true, force: true });
  jest.restoreAllMocks(); resetCapabilityStatus();
});

function ui(): typeof initialEngineState { return wire.reduce((s, msg) => engineReducer(s, { type: 'outbound', msg }), initialEngineState); }
function notices(id: string) { return wire.filter(m => m.args?.[0]?.payload?.capabilityStatus?.id === id); }
function embedding(timeoutMs = 250) { return new RemoteEmbeddingBackend({ resolve: async () => credential, model: 'fixture', dimensions: 2, timeoutMs }); }
const good = { data: [{ index: 0, embedding: [1, 0] }] };

test('HTTP 410 reaches the user automatically, stays through clear, and recovers only after valid use', async () => {
  const backend = embedding();
  expect(await backend.embed(['private corpus'], 'query')).toBeNull();
  expect(ui().capabilities.embeddings.reason).toContain('410');
  expect(ui().items.some(item => item.kind === 'msg' && item.msg.content.includes('keywords only'))).toBe(true);
  await backend.embed(['again'], 'query');
  expect(requests).toBe(1); expect(notices('embeddings')).toHaveLength(1);
  const cleared = engineReducer(ui(), { type: 'outbound', msg: { t: 'event', name: 'clear', args: [] } });
  expect(cleared.capabilities.embeddings).toBeDefined();
  reply = { status: 200, payload: good };
  const later = Date.now() + 31_000;
  jest.spyOn(Date, 'now').mockReturnValue(later);
  expect(await backend.embed(['again'], 'query')).toEqual([[1, 0]]);
  expect(ui().capabilities.embeddings).toBeUndefined();
  expect(notices('embeddings').map(m => m.args[0].payload.capabilityStatus.state)).toEqual(['degraded', 'ready']);
  expect(JSON.stringify(wire)).not.toContain('private-test-key');
  expect(JSON.stringify(wire)).not.toContain('private corpus');
});

test.each([401, 429, 500])('HTTP %s is visible without opening diagnostics', async status => {
  reply = { status };
  expect(await embedding().embed(['x'], 'query')).toBeNull();
  expect(ui().capabilities.embeddings.reason).toContain(String(status));
});

test.each([
  { data: [] }, { data: [{ index: 0, embedding: [0, 0] }] },
  { data: [{ index: 0, embedding: ['NaN', 1] }] },
  { data: [{ index: 1, embedding: [1, 0] }] },
])('invalid HTTP 200 cannot claim semantic recovery: %j', async payload => {
  reply = { status: 200, payload };
  expect(await embedding().embed(['x'], 'query')).toBeNull();
  expect(ui().capabilities.embeddings.state).toBe('degraded');
});

test('duplicate embedding indices are rejected even when row count matches', async () => {
  reply = { status: 200, payload: { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] } };
  expect(await embedding().embed(['x', 'y'], 'passage')).toBeNull();
  expect(ui().capabilities.embeddings.reason).toContain('indices');
});

test('hung real HTTP response is bounded and announces the timeout', async () => {
  reply = { status: 200, hang: true };
  const start = Date.now();
  expect(await embedding(40).embed(['x'], 'query')).toBeNull();
  expect(Date.now() - start).toBeLessThan(1000);
  expect(ui().capabilities.embeddings.reason).toContain('timed out');
});

test('hung credentials and abort-ignoring transport are bounded too', async () => {
  for (const options of [
    { resolve: () => new Promise<null>(() => {}) },
    { resolve: async () => credential, transport: () => new Promise<any>(() => {}) },
  ]) {
    const backend = new RemoteEmbeddingBackend({ ...options, timeoutMs: 20 });
    expect(await backend.embed(['x'], 'query')).toBeNull();
    expect(ui().capabilities.embeddings).toBeDefined();
  }
});

test('reranker outage, duplicate indices, partial coverage, and recovery are explicit', async () => {
  const ranker = new RemoteReranker({ resolve: async () => credential, timeoutMs: 250 });
  const candidates = [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }];
  reply = { status: 404 };
  expect(await ranker.rerank('q', candidates)).toBeNull();
  expect(ui().capabilities.reranking.reason).toContain('404');
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
  reply = { status: 200, payload: { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 2 }] } };
  expect(await ranker.rerank('q', candidates)).toBeNull();
  reply.payload.results = [{ index: 0, relevance_score: 1 }];
  expect(await ranker.rerank('q', candidates)).toHaveLength(1);
  expect(ui().capabilities.reranking.reason).toContain('only some');
  reply.payload.results.push({ index: 1, relevance_score: 2 });
  expect((await ranker.rerank('q', candidates))?.map(h => h.id)).toEqual(['b', 'a']);
  expect(ui().capabilities.reranking).toBeUndefined();
});

test('partial index is visible; lexical-only completion does not claim missing embeddings', async () => {
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const apple = 1;');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const banana = 2;');
  const index = new CodeIndex(null, null, { root });
  expect((await index.sync(1)).pending).toBe(1);
  expect(Object.values(ui().capabilities).some(n => n.label === 'Code index')).toBe(true);
  expect((await index.sync(1)).pending).toBe(0);
  expect((await index.search('banana', 3))[0]?.path).toBe('b.ts');
  expect(Object.values(ui().capabilities).some(n => n.label === 'Code index')).toBe(false);
});

test('overlapping sync calls share actual coverage instead of reporting false zero pending', async () => {
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const apple = 1;');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const banana = 2;');
  const index = new CodeIndex(null, null, { root });
  const [a, b] = await Promise.all([index.sync(1), index.sync(1)]);
  expect(a).toEqual(b); expect(b.pending).toBe(1);
});

test('storage initialization failure is announced, never presented as no matching code', async () => {
  const index = new CodeIndex(null, null, { root, storePath: root });
  await expect(index.sync()).rejects.toThrow();
  expect(Object.values(ui().capabilities).some(n => n.reason.includes('failed'))).toBe(true);
});

test('directory boundary is enforced with persistent allow and bypass, including symlink ancestors', async () => {
  const governor = new Governor({ emit: () => {} } as any);
  const inside = path.join(root, 'inside'); fs.mkdirSync(inside);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  SafetyPolicy.allowedWorkspace = inside;
  fs.symlinkSync(outside, path.join(inside, 'link'));
  const mkdir = createMakeDirTool(governor);
  for (const mode of ['interactive', 'bypass'] as const) {
    governor.mode = mode; governor.addRule({ tool: 'FILE_WRITE', effect: 'allow', persistent: true });
    for (const target of [path.join(outside, 'bad'), path.join(inside, 'link/new/nested')]) {
      await expect(mkdir.execute({ path: target })).rejects.toThrow('workspace boundary');
      expect(fs.existsSync(target)).toBe(false);
      expect(ui().capabilities['tool:CreateDirectoryTool']).toBeDefined();
    }
  }
  await mkdir.execute({ path: 'good/nested' }, { cwd: inside });
  expect(fs.statSync(path.join(inside, 'good/nested')).isDirectory()).toBe(true);
  expect(ui().capabilities['tool:CreateDirectoryTool']).toBeUndefined();
  governor.mode = 'plan';
  await expect(mkdir.execute({ path: path.join(inside, 'plan-write') })).rejects.toThrow('Plan mode');
  expect(fs.existsSync(path.join(inside, 'plan-write'))).toBe(false);
});

test('text disguised as docx is refused and the user sees the failure', async () => {
  const governor = new Governor({ emit: () => {} } as any); governor.mode = 'bypass';
  const target = path.join(root, 'report.docx');
  const result = await createWriteFileTool(governor).execute({ path: target, content: '# report' });
  expect(result).toContain('Use DocumentTool'); expect(fs.existsSync(target)).toBe(false);
  expect(ui().capabilities['tool:WriteFileTool']).toBeDefined();
});

test('typed and legacy tool errors produce notices independently of model narration', async () => {
  for (const result of [outcomeError('io', 'Error: fixture failed'), 'Error: fixture failed']) {
    const tool = buildTool({ name: 'FixtureTool', description: '', schema: {}, execute: async () => result }, { approveTaskExecution: async () => {} });
    await tool.execute({});
    expect(ui().capabilities['tool:FixtureTool']).toBeDefined();
  }
});

test('pre-host failures replay and capability messages have reserved transport capacity', () => {
  dispose();
  reportCapability({ id: 'early', label: 'Early capability', state: 'unavailable', reason: 'Failed before attachment.', impact: '', action: '' });
  wire = [];
  dispose = startStdioHost({ emitter: cliEvents, input, output });
  expect(ui().capabilities.early).toBeDefined();
  expect(outboundClass(notices('early')[0])).toBe('critical');
  expect(capabilitySnapshot().some(n => n.id === 'early')).toBe(true);
});


test('status overflow stays bounded and does not flood or hide existing failures', () => {
  for (let i = 0; i < 1000; i++) reportCapability({ id: `overflow-${i}`, label: 'Fixture',
    state: 'unavailable', reason: 'Failed.', impact: 'Unavailable.', action: 'Retry.' });
  expect(capabilitySnapshot()).toHaveLength(128);
  expect(notices('additional-capabilities')).toHaveLength(1);
  expect(ui().capabilities['overflow-0']).toBeDefined();
});

test('dangling symlink ancestors fail closed before directory creation', async () => {
  const inside = path.join(root, 'inside'); fs.mkdirSync(inside);
  SafetyPolicy.allowedWorkspace = inside;
  const missing = path.join(root, 'missing-outside');
  fs.symlinkSync(missing, path.join(inside, 'dangling'));
  const governor = new Governor({ emit: () => {} } as any); governor.mode = 'bypass';
  await expect(createMakeDirTool(governor).execute({ path: path.join(inside, 'dangling/new/nested') })).rejects.toThrow('symbolic link');
  expect(fs.existsSync(missing)).toBe(false);
});

test('MCP startup failure reaches the user and a real successful handshake clears it', async () => {
  const { McpManager } = await import('../mcp/manager');
  const { ToolRegistry } = await import('../tools/tool.registry');
  const manager = new McpManager(); const registry = new ToolRegistry();
  const governor = { approveTaskExecution: async () => {} };
  try {
    expect(await manager.connectSpec({ name: 'proof', command: path.join(root, 'missing-command'), args: [] }, registry, governor)).toBeNull();
    expect(ui().capabilities['mcp:proof'].state).toBe('unavailable');
    const live = await manager.connectSpec({ name: 'proof', command: process.execPath,
      args: [path.join(__dirname, 'fixtures/mcp-echo-server.js')] }, registry, governor);
    expect(live).not.toBeNull(); expect(ui().capabilities['mcp:proof']).toBeUndefined();
    const tool = registry.getTool('mcp__proof__echo')!;
    let outcome: any;
    await tool.execute({ text: '__error__' }, { reportOutcome: (value: any) => { outcome = value; } });
    expect(outcome.status).toBe('error');
    expect(ui().capabilities['tool:mcp__proof__echo']).toBeDefined();
    await tool.execute({ text: 'healthy' });
    expect(ui().capabilities['tool:mcp__proof__echo']).toBeUndefined();
  } finally { await manager.disconnect('proof', registry); }
});

test('memory read failure and recovery are visible without asking for diagnostics', async () => {
  const { recallForTurn } = await import('../memory/recall');
  const semanticSearch = jest.fn().mockRejectedValueOnce(new Error('private data')).mockResolvedValueOnce([]);
  await recallForTurn({ semanticSearch } as any, 'fixture query');
  expect(ui().capabilities['memory-recall']).toBeDefined();
  expect(JSON.stringify(wire)).not.toContain('private data');
  await recallForTurn({ semanticSearch } as any, 'another query');
  expect(ui().capabilities['memory-recall']).toBeUndefined();
});

test('corrupt memory storage is visible and cannot be replaced by a successful empty-store write', async () => {
  const { VectorStore } = await import('../memory/vector.store');
  const target = path.join(root, 'corrupt-memory.json');
  const original = '{invalid json'; fs.writeFileSync(target, original);
  const store = new VectorStore(null, null, { storePath: target });
  await expect(store.semanticSearch('fixture')).rejects.toThrow();
  await expect(store.storeDocument('one', 'new content', [])).rejects.toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe(original);
  expect(ui().capabilities['memory-storage-read']).toBeDefined();
  fs.writeFileSync(target, '[]');
  expect(await store.semanticSearch('fixture')).toEqual([]);
  expect(ui().capabilities['memory-storage-read']).toBeUndefined();
});
