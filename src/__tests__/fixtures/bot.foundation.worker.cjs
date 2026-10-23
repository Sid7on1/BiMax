// Real worker and production context/RAG classes, with a deterministic offline reader.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { parentPort, workerData: config } = require('node:worker_threads');
const root = process.env.BIMAX_TEST_SOURCE_ROOT || path.resolve(__dirname, '../../..');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, file);
process.env.BIMAX_STATE_DIR = path.join(config.botRun.catalogDirectory, 'fixture-state', config.botRun.runId);
process.env.BIMAX_BREAKGLASS_DIR = path.join(process.env.BIMAX_STATE_DIR, 'config');
(async () => {
  const { validateBotAssignment, applyBotWorkerPolicy, botMemoryFile } = require(path.join(root, 'src/bots/worker.policy.ts'));
  const { createMemoryRetrieval } = require(path.join(root, 'src/memory/retrieval.factory.ts'));
  const { ToolRegistry } = require(path.join(root, 'src/tools/tool.registry.ts'));
  const { AgentLoop } = require(path.join(root, 'src/core/agent.loop.ts'));
  const { ContextManager } = require(path.join(root, 'src/memory/context.manager.ts'));
  const { loadConfig } = require(path.join(root, 'src/engine/config.ts'));
  const { inheritRunBudget } = require(path.join(root, 'src/core/run.budget.ts'));
  await loadConfig(); inheritRunBudget(config.runBudget);
  const run = await validateBotAssignment(config.botRun, config.cwd);
  const retrieval = createMemoryRetrieval({ resolveChat: async () => null, localRerank: false,
    store: { storePath: botMemoryFile(run) } });
  const registry = new ToolRegistry();
  for (const name of ['MemoryQueryTool', 'BashTool', 'SpawnSubagentTool']) registry.register({ name,
    description: name, schema: { type: 'object', properties: {} }, isDestructive: name === 'BashTool',
    isConcurrencySafe: true, execute: async () => 'fixture' });
  await applyBotWorkerPolicy(run, registry);
  let shown = '';
  const llm = { chat: async function* (messages) {
    shown = messages.map(message => message.content || '').join('\n');
    yield { type: 'token', text: 'Offline fixture completed with scoped memory evidence.' }; yield { type: 'done' };
  } };
  const manager = new ContextManager(llm, 32_000);
  const loop = new AgentLoop(llm, registry, undefined, 32_000, manager, retrieval.store);
  for await (const _ of loop.execute([{ role: 'user', content: run.task }], run.handoff.text,
    { maxIterations: 1, skipRepoMap: true }, { cwd: config.cwd })) { /* consume */ }
  if (config.runBudget) Atomics.add(new BigInt64Array(config.runBudget), 0, 7n);
  parentPort.postMessage({ type: 'success', result: JSON.stringify({ botId: run.definition.id, runId: run.runId,
    shown, tools: registry.getToolNames(), evidence: manager.evidence.all().map(span => span.text) }) });
  parentPort.close();
})().catch(error => { parentPort.postMessage({ type: 'error', error: error.stack || String(error) }); parentPort.close(); });
