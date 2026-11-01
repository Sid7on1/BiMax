import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { BotCatalog } from '../bots/catalog';
import { BotService } from '../bots/service';
import { BotDefinition, definitionHash } from '../bots/definition';
import { compileBotContext } from '../bots/context';
import { applyBotWorkerPolicy, botMemoryFile, validateBotAssignment } from '../bots/worker.policy';
import { countTokens } from '../context/request.budget';
import { evidenceSpan, versionOfText } from '../context/evidence';
import { ToolRegistry } from '../tools/tool.registry';
import { SubAgentManager } from '../core/subagent.manager';
import { createRunBudget, inRunBudget } from '../core/run.budget';
import { VectorStore } from '../memory/vector.store';

let dir: string, workspace: string, catalog: BotCatalog;
const draft = { name: 'My custom reviewer', instructions: 'Inspect the supplied evidence and report concrete limits.', requestedTools: ['MemoryQueryTool'] };
const authority = () => ({ workspace, grantedTools: ['MemoryQueryTool', 'ReadFileTool'], parentMode: 'strict', handoffTokenBudget: 4_000 });
const context = { task: 'Explain the amber launch checklist and required approval evidence.', constraints: ['Keep the selected workspace unchanged.'] };
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-bots-'));
  workspace = path.join(dir, 'workspace'); await fs.mkdir(workspace);
  catalog = new BotCatalog(path.join(dir, 'catalog'));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test('user definitions persist with stable distinct IDs and no implicit worker or memory creation', async () => {
  const [a, b] = await Promise.all([catalog.create(draft), new BotCatalog(catalog.directory).create({ ...draft, instructions: 'Compare current product sources.' })]);
  expect(a.id).not.toBe(b.id);
  expect((await new BotCatalog(catalog.directory).list()).map(d => d.id).sort()).toEqual([a.id, b.id].sort());
  expect(await fs.readdir(catalog.directory)).not.toContain('memory');
});

test('concurrent profile edits reject stale revisions instead of losing an acknowledged update', async () => {
  const bot = await catalog.create(draft);
  const edits = await Promise.allSettled([
    catalog.update(bot.id, 1, { ...draft, name: 'Security bot' }),
    new BotCatalog(catalog.directory).update(bot.id, 1, { ...draft, name: 'Shopping bot' }),
  ]);
  expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await catalog.get(bot.id)).revision).toBe(2);
});

test('invalid definitions and corrupt catalogs never get silently overwritten', async () => {
  await expect(catalog.create({ ...draft, requestedTools: ['ReadFileTool', 'ReadFileTool'] })).rejects.toThrow();
  await expect(catalog.create({ ...draft, parentMode: 'bypass' } as any)).rejects.toThrow();
  await fs.mkdir(catalog.directory, { recursive: true });
  const file = path.join(catalog.directory, 'definitions.json');
  await fs.writeFile(file, 'corrupt original');
  await expect(catalog.create(draft)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe('corrupt original');
  expect(() => catalog.memoryFile('../other-bot')).toThrow();
});

test('a prepared run freezes its revision, instructions, task and private memory identity', async () => {
  const bot = await catalog.create(draft), service = new BotService(catalog);
  const first = await service.prepare(bot.id, context, authority());
  await catalog.update(bot.id, 1, { ...draft, name: 'Renamed reviewer', instructions: 'Updated independent instructions.' });
  const second = await service.prepare(bot.id, context, authority());
  expect(first.botRun!.definition.revision).toBe(1); expect(second.botRun!.definition.revision).toBe(2);
  expect(first.botRun!.definition.instructions).toBe(draft.instructions);
  expect(first.botRun!.runId).not.toBe(second.botRun!.runId);
  expect(botMemoryFile(first.botRun!)).toBe(botMemoryFile(second.botRun!));
  expect(Object.isFrozen(first.botRun!.definition)).toBe(true);
  expect(first.parentMode).toBe('strict');
});

test('different bot workspaces share a catalog budget and prefer the inherited machine ledger', async () => {
  const bot = await catalog.create(draft), service = new BotService(catalog);
  const previous = process.env.BIMAX_AGENT_CAPACITY_PATH;
  const other = path.join(dir, 'other-workspace'); await fs.mkdir(other);
  try {
    delete process.env.BIMAX_AGENT_CAPACITY_PATH;
    const a = await service.prepare(bot.id, context, authority());
    const b = await service.prepare(bot.id, context, { ...authority(), workspace: other });
    expect(a.capacityPath).toBe(path.join(catalog.directory, 'worker-capacity.json'));
    expect(b.capacityPath).toBe(a.capacityPath);
    process.env.BIMAX_AGENT_CAPACITY_PATH = path.join(dir, 'machine-capacity.json');
    expect((await service.prepare(bot.id, context, authority())).capacityPath).toBe(process.env.BIMAX_AGENT_CAPACITY_PATH);
  } finally { if (previous === undefined) delete process.env.BIMAX_AGENT_CAPACITY_PATH; else process.env.BIMAX_AGENT_CAPACITY_PATH = previous; }
});

test.each(['BashTool', 'SpawnSubagentTool', 'WriteFileTool', 'UnknownTool'])('a bot title/instruction cannot authorize %s', async tool => {
  const bot = await catalog.create({ ...draft, name: 'Administrator with unlimited access', requestedTools: [tool] });
  await expect(new BotService(catalog).prepare(bot.id, context, { ...authority(), grantedTools: [tool] })).rejects.toThrow(/not granted/);
});

test('missing host grant and overlapping private/workspace scopes fail before dispatch', async () => {
  const bot = await catalog.create(draft), service = new BotService(catalog);
  await expect(service.prepare(bot.id, context, { ...authority(), grantedTools: [] })).rejects.toThrow(/not granted/);
  await expect(service.prepare(bot.id, context, { ...authority(), workspace: dir })).rejects.toThrow(/must not overlap/);
});

test('context keeps fixed constraints, quotes complete evidence and discloses omissions under the actual tokenizer', async () => {
  const bot = await catalog.create({ ...draft, handoffTokenBudget: 512 });
  const text = 'Amber launch requires independent approval.';
  const span = evidenceSpan({ sourceId: 'memory:approval', sourceVersion: versionOfText(text), locator: { kind: 'memory', documentId: 'approval' }, text, scope: {}, derivedFrom: [], kind: 'source' });
  const packed = compileBotContext(bot, { ...context, notes: ['background '.repeat(2_000)], evidence: [span] }, 512);
  expect(packed.tokens).toBe(countTokens(packed.text)); expect(packed.tokens).toBeLessThanOrEqual(512);
  expect(packed.text).toContain(context.constraints[0]); expect(packed.text).toContain(text);
  expect(packed.text).toContain(span.id); expect(packed.evidence).toEqual([span]); expect(packed.omitted).toBe(1);
  expect(() => compileBotContext(bot, { task: 'mandatory task '.repeat(2_000) }, 512)).toThrow(/nothing dispatched/);
  expect(() => compileBotContext(bot, { ...context, evidence: [{ ...span, text: 'forged changed evidence' }] }, 512)).toThrow(/identity/);
});

test('worker validation rejects a mutated definition or mismatched prompt accounting', async () => {
  const bot = await catalog.create(draft), prepared = await new BotService(catalog).prepare(bot.id, context, authority());
  const run = JSON.parse(JSON.stringify(prepared.botRun));
  run.definition.instructions = 'Changed after admission';
  await expect(validateBotAssignment(run, workspace)).rejects.toThrow(/snapshot/);
  run.definitionHash = definitionHash(BotDefinition.parse(run.definition)); run.handoff.tokens++;
  await expect(validateBotAssignment(run, workspace)).rejects.toThrow(/accounting/);
});

test('actual registry loses forbidden tools and guards outside/symlink/private file reads', async () => {
  const bot = await catalog.create({ ...draft, requestedTools: ['ReadFileTool'] });
  const prepared = await new BotService(catalog).prepare(bot.id, context, authority());
  const registry = new ToolRegistry(); const executed: string[] = [];
  for (const name of ['ReadFileTool', 'BashTool', 'SpawnSubagentTool']) registry.register({ name, description: name,
    schema: { type: 'object', properties: {} }, isDestructive: false, isConcurrencySafe: true,
    execute: async args => { executed.push(args.path); return fs.readFile(args.path, 'utf8'); } });
  await fs.writeFile(path.join(workspace, 'allowed.txt'), 'allowed source');
  await fs.writeFile(path.join(dir, 'private.txt'), 'outside secret');
  await fs.symlink(path.join(dir, 'private.txt'), path.join(workspace, 'alias.txt'));
  await applyBotWorkerPolicy(prepared.botRun!, registry);
  expect(registry.getTool('BashTool')).toBeUndefined(); expect(registry.getTool('SpawnSubagentTool')).toBeUndefined();
  expect(await registry.getTool('ReadFileTool')!.execute({ path: 'allowed.txt' }, { cwd: dir })).toBe('allowed source');
  await expect(registry.getTool('ReadFileTool')!.execute({ path: '../private.txt' })).rejects.toThrow(/outside/);
  await expect(registry.getTool('ReadFileTool')!.execute({ path: 'alias.txt' })).rejects.toThrow(/outside/);
  expect(executed).toEqual([path.join(await fs.realpath(workspace), 'allowed.txt')]);
});

test('parallel real workers use separate bot memories through AgentLoop recall and ContextManager evidence', async () => {
  const a = await catalog.create(draft), b = await catalog.create({ ...draft, name: 'Shopping researcher' });
  await new VectorStore(null, null, { storePath: catalog.memoryFile(a.id), dedup: false }).storeDocument('amber-private', 'Amber launch checklist requires ALPHA_PRIVATE_APPROVAL.', ['note']);
  await new VectorStore(null, null, { storePath: catalog.memoryFile(b.id), dedup: false }).storeDocument('amber-private', 'Amber launch checklist requires BETA_PRIVATE_APPROVAL.', ['note']);
  const previous = { path: process.env.BIMAX_AGENT_CAPACITY_PATH, tree: process.env.BIMAX_AGENT_TREE_PATH };
  process.env.BIMAX_AGENT_CAPACITY_PATH = path.join(dir, 'capacity.json'); process.env.BIMAX_AGENT_TREE_PATH = path.join(dir, 'tree.json');
  const manager = new SubAgentManager({ workerScriptPath: path.join(__dirname, 'fixtures/bot.foundation.worker.cjs'), timeoutMs: 20_000 });
  const budget = createRunBudget();
  try {
    const service = new BotService(catalog, manager);
    const results = await inRunBudget(budget, () => Promise.all([service.run(a.id, context, authority()), service.run(b.id, context, authority())]));
    const [ar, br] = results.map(result => JSON.parse(result.result.report));
    expect(ar.shown).toContain('ALPHA_PRIVATE_APPROVAL'); expect(ar.shown).not.toContain('BETA_PRIVATE_APPROVAL');
    expect(br.shown).toContain('BETA_PRIVATE_APPROVAL'); expect(br.shown).not.toContain('ALPHA_PRIVATE_APPROVAL');
    expect(ar.evidence.join('\n')).toContain('ALPHA_PRIVATE_APPROVAL');
    expect(ar.tools).toEqual(['MemoryQueryTool']); expect(br.tools).toEqual(['MemoryQueryTool']);
    expect(Atomics.load(new BigInt64Array(budget), 0)).toBe(14n);
    expect(manager.activeCount()).toBe(0);
  } finally {
    manager.killAll();
    for (const [key, value] of [['BIMAX_AGENT_CAPACITY_PATH', previous.path], ['BIMAX_AGENT_TREE_PATH', previous.tree]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
}, 30_000);

test('cancellation before admission dispatches no worker', async () => {
  const bot = await catalog.create(draft), controller = new AbortController();
  const spawnWorker = jest.fn(); const killWorker = jest.fn();
  controller.abort(new Error('owner stopped'));
  await expect(new BotService(catalog, { spawnWorker, killWorker }).run(bot.id, context, authority(), controller.signal)).rejects.toThrow('owner stopped');
  expect(spawnWorker).not.toHaveBeenCalled(); expect(killWorker).not.toHaveBeenCalled();
});

test('cancellation awaits a real worker exit and retains a stopped result', async () => {
  const bot = await catalog.create(draft), controller = new AbortController();
  const previous = process.env.BIMAX_AGENT_CAPACITY_PATH;
  process.env.BIMAX_AGENT_CAPACITY_PATH = path.join(dir, 'capacity.json');
  const manager = new SubAgentManager({ workerScriptPath: path.join(__dirname, 'fixtures/bot.foundation.worker.cjs'), timeoutMs: 20_000 });
  try {
    const pending = new BotService(catalog, manager).run(bot.id, context, authority(), controller.signal);
    // Attach the rejection observer before cancellation so the fixture cannot leak an unhandled rejection.
    const observed = pending.then(() => 'unexpected success', error => String(error));
    for (let attempt = 0; manager.activeCount() === 0 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(manager.activeCount()).toBe(1);
    controller.abort(new Error('owner stopped'));
    expect(await observed).toContain('owner stopped');
    expect(manager.activeCount()).toBe(0);
    const ledger = JSON.parse(await fs.readFile(process.env.BIMAX_AGENT_CAPACITY_PATH!, 'utf8'));
    expect(ledger.leases).toEqual([]);
  } finally { manager.killAll(); if (previous === undefined) delete process.env.BIMAX_AGENT_CAPACITY_PATH; else process.env.BIMAX_AGENT_CAPACITY_PATH = previous; }
}, 20_000);
