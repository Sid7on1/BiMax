import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as dotenv from 'dotenv';
import { encode } from 'gpt-tokenizer';
import type { ChatEvent, ChatOptions, LLMProvider, Message } from '../../src/core/llm.provider';

type RunMode = 'offline-trajectory-smoke' | 'live';

interface TaskManifest {
  id: string;
  fixture: string;
  promptFile: string;
  trajectoryFile: string;
  successCheck: { command: string; args: string[]; timeoutMs?: number };
}

type TrajectoryStep = {
  expectLastToolContains?: string;
  tool: string;
  args: Record<string, unknown>;
} | {
  expectLastToolContains?: string;
  text: string;
};

interface TaskResult {
  id: string;
  prompt: string;
  passed: boolean;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
  wallClockMs: number;
  contextRecoveryFired: boolean;
  usageComplete: boolean;
  completionTokenSource: 'tokenizer-estimate-from-recorded-text-and-tool-calls';
  reasoningTokenSource: 'tokenizer-estimate-from-recorded-thinking';
  crashed?: boolean;
  agentError?: string;
  check: { command: string; exitCode: number; stdout: string; stderr: string };
  episode: { id: string; chainOk: boolean; file?: string };
}

interface RecordedCallLike {
  response?: {
    text?: string;
    thinking?: string;
    toolCalls?: Array<{ id?: string; name: string; args: string }>;
    usage?: { prompt: number; completion?: number };
  };
}

interface EpisodeMeasurement {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
  usageComplete: boolean;
}

interface RemeasuredTaskResult extends EpisodeMeasurement {
  id: string;
  taskId: string;
  passed?: boolean;
  passStatus: 'carried-forward-from-source-report' | 'from-episode-unknown';
  contextRecoveryFired?: boolean;
  completionTokenSource: 'tokenizer-estimate-from-recorded-text-and-tool-calls';
  reasoningTokenSource: 'tokenizer-estimate-from-recorded-thinking';
  episode: { id: string; chainOk: boolean; file: string };
}

const REPO_ROOT = process.cwd();
const AUTONOMY_ROOT = path.join(REPO_ROOT, 'benchmarks', 'autonomy');
const DEFAULT_TASK = path.join(AUTONOMY_ROOT, 'tasks', '01-order-summary');
const SYSTEM_PROMPT = [
  'You are the BiMax autonomy baseline agent.',
  'Work only in the provided fixture workspace.',
  'Inspect the task, make the smallest correct change, run the focused test, and report the result.',
].join(' ');
const LIVE_MAX_ITERATIONS = 40;

function tokenCount(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  try { return encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

class OfflineTrajectoryProvider implements LLMProvider {
  private index = 0;

  constructor(private readonly steps: TrajectoryStep[]) {}

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
    const step = this.steps[this.index++];
    if (!step) {
      yield { type: 'error', message: 'Offline trajectory exhausted.', recoverable: false };
      return;
    }

    const expected = step.expectLastToolContains;
    if (expected) {
      const latest = [...messages].reverse().find(message => message.role === 'tool');
      const actual = typeof latest?.content === 'string' ? latest.content : '';
      if (!actual.includes(expected)) {
        yield {
          type: 'error',
          message: `Offline trajectory expected the latest tool result to contain ${JSON.stringify(expected)}.`,
          recoverable: false,
        };
        return;
      }
    }

    const promptTokens = tokenCount({ system: options.system || '', tools: options.tools || [], messages });
    let completionTokens: number;
    if ('tool' in step) {
      const event: ChatEvent = {
        type: 'tool_call',
        id: `autonomy-${this.index}`,
        name: step.tool,
        args: JSON.stringify(step.args),
      };
      completionTokens = tokenCount(event);
      yield event;
    } else {
      completionTokens = tokenCount(step.text);
      yield { type: 'token', text: step.text };
    }
    yield { type: 'usage', prompt: promptTokens, completion: completionTokens };
    yield { type: 'done' };
  }
}

interface LiveProviderSetup {
  provider: LLMProvider;
  contextWindowTokens: number;
  maxIterations: number;
}

async function createLiveProvider(): Promise<LiveProviderSetup> {
  // Match CLI startup order: global BiMax env first, then the launch directory's .env.
  const { loadGlobalEnv } = await import('../../src/engine/env.loader');
  loadGlobalEnv();
  dotenv.config({ path: path.join(REPO_ROOT, '.env') });

  const [
    { loadConfig },
    { buildKeyPool },
    { ApiKeyManager },
    { LlmAdapter },
  ] = await Promise.all([
    import('../../src/engine/config'),
    import('../../src/engine/provider'),
    import('../../src/credits/api.key.manager'),
    import('../../src/core/llm.adapter'),
  ]);
  const config = await loadConfig();
  const keyPool = buildKeyPool();
  if (keyPool.length === 0) {
    throw new Error(
      'Live mode found no API key in the normal BiMax environment. Configure a provider key ' +
      '(for example NVIDIA_API_KEY) in the environment, the repository .env, or ~/.breakglass/.env.',
    );
  }

  // This is the same real provider and configuration wiring used by createContainer().
  const provider = new LlmAdapter(new ApiKeyManager(keyPool));
  provider.applyConfig({
    model: config.model,
    timeout: config.timeout,
    temperature: config.temperature,
    topP: config.topP,
    maxTokens: config.maxTokens,
    reasoningEffort: config.reasoningEffort,
    parallelToolCalls: config.parallelToolCalls,
    liteModel: config.liteModel,
  });

  return {
    provider,
    contextWindowTokens: config.contextWindowTokens || 128_000,
    maxIterations: Math.min(Math.max(1, config.maxToolIterations || LIVE_MAX_ITERATIONS), LIVE_MAX_ITERATIONS),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function recordedCompletionTokens(response: {
  text?: string;
  toolCalls?: Array<{ name: string; args: string }>;
} | undefined): number {
  if (!response) return 0;
  const content = [
    response.text || '',
    ...(response.toolCalls || []).map(call => JSON.stringify({ name: call.name, args: call.args })),
  ].filter(Boolean).join('\n');
  return content ? tokenCount(content) : 0;
}

function recordedReasoningTokens(response: { thinking?: string } | undefined): number {
  return response?.thinking ? tokenCount(response.thinking) : 0;
}

function measureEpisodeCalls(calls: RecordedCallLike[]): EpisodeMeasurement {
  const usage = calls.map(call => call.response?.usage);
  const completionTokenEstimates = calls.map(call => recordedCompletionTokens(call.response));
  const reasoningTokenEstimates = calls.map(call => recordedReasoningTokens(call.response));
  const totalPromptTokens = usage.reduce((sum, item) => sum + (item?.prompt || 0), 0);
  const totalCompletionTokens = completionTokenEstimates.reduce((sum, count) => sum + count, 0);
  const reasoningTokens = reasoningTokenEstimates.reduce((sum, count) => sum + count, 0);
  return {
    totalPromptTokens,
    totalCompletionTokens,
    reasoningTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens + reasoningTokens,
    turnCount: calls.length,
    toolCallCount: calls.reduce(
      (sum, call) => sum + (call.response?.toolCalls?.length || 0),
      0,
    ),
    usageComplete: usage.length > 0 && usage.every(Boolean) &&
      completionTokenEstimates.length > 0 && completionTokenEstimates.every(
        (visibleTokens, index) => visibleTokens > 0 || reasoningTokenEstimates[index] > 0,
      ),
  };
}

function resolveCheck(manifest: TaskManifest, taskDir: string): { command: string; args: string[] } {
  const command = manifest.successCheck.command === 'node' ? process.execPath : manifest.successCheck.command;
  const args = manifest.successCheck.args.map(arg => arg.startsWith('./') ? path.resolve(taskDir, arg) : arg);
  return { command, args };
}

async function discoverSuiteTasks(): Promise<string[]> {
  const tasksRoot = path.join(AUTONOMY_ROOT, 'tasks');
  const entries = await fsp.readdir(tasksRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => path.join(tasksRoot, entry.name));
}

async function createSuiteLogAnchor(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bimax-autonomy-suite-'));
  const originalCwd = process.cwd();
  try {
    // Logger resolves its file once at module load. Anchor it to a run-scoped directory so deleting
    // task N's workspace cannot leave task N+1 writing to a stale path.
    process.chdir(root);
    await import('../../src/utils/logger');
    return root;
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    process.chdir(originalCwd);
  }
}

async function runTask(
  taskDir: string,
  mode: RunMode,
  runId: string,
  liveSetup?: LiveProviderSetup,
): Promise<TaskResult> {
  const started = performance.now();
  const manifest = JSON.parse(await fsp.readFile(path.join(taskDir, 'task.json'), 'utf8')) as TaskManifest;
  const prompt = (await fsp.readFile(path.join(taskDir, manifest.promptFile), 'utf8')).trim();
  const trajectory = mode === 'offline-trajectory-smoke'
    ? JSON.parse(await fsp.readFile(path.join(taskDir, manifest.trajectoryFile), 'utf8')) as TrajectoryStep[]
    : null;
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), `bimax-autonomy-${manifest.id}-`));
  const originalCwd = process.cwd();
  const oldFloor = process.env.BIMAX_SANDBOX_FLOOR;
  let contextRecoveryFired = false;
  let agentError: string | undefined;

  try {
    await fsp.cp(path.join(taskDir, manifest.fixture), workspace, { recursive: true });
    process.chdir(workspace);
    // BashTool's existing autonomy floor denies network and confines writes to this temp workspace.
    process.env.BIMAX_SANDBOX_FLOOR = workspace;

    // Dynamic imports happen after chdir so cwd-anchored production helpers (backups, ledgers,
    // episode files) are rooted in the disposable fixture rather than the BiMax checkout.
    const [
      { AgentLoop },
      { ToolRegistry },
      { EpisodeWriter, RecordingProvider, loadEpisode },
      { createReadFileTool },
      { createEditFileTool },
      { createBashTool },
      { cliEvents },
    ] = await Promise.all([
      import('../../src/core/agent.loop'),
      import('../../src/tools/tool.registry'),
      import('../../src/mind/episode.recorder'),
      import('../../src/tools/implementations/file.tool'),
      import('../../src/tools/implementations/edit.tool'),
      import('../../src/tools/implementations/bash.tool'),
      import('../../src/engine/events'),
    ]);

    const onLog = (entry: any): void => {
      const text = typeof entry === 'string' ? entry : String(entry?.text || '');
      if (/Context recovery tier|Context overflow/i.test(text)) contextRecoveryFired = true;
    };
    const onStatus = (text: unknown): void => {
      if (/Context overflow/i.test(String(text || ''))) contextRecoveryFired = true;
    };
    cliEvents.on('log', onLog);
    cliEvents.on('status', onStatus);

    const governor = { approveTaskExecution: async (): Promise<void> => {} };
    const registry = new ToolRegistry();
    registry.register(createReadFileTool(governor));
    registry.register(createEditFileTool(governor));
    registry.register(createBashTool(governor));

    const innerProvider = mode === 'live'
      ? liveSetup?.provider
      : new OfflineTrajectoryProvider(trajectory || []);
    if (!innerProvider) throw new Error('Live provider setup is missing.');
    const maxIterations = mode === 'live'
      ? liveSetup!.maxIterations
      : (trajectory?.length || 0) + 2;
    const contextWindowTokens = mode === 'live' ? liveSetup!.contextWindowTokens : 128_000;
    const writer = new EpisodeWriter(workspace);
    const provider = new RecordingProvider(innerProvider, writer);
    const loop = new AgentLoop(provider, registry, undefined, contextWindowTokens);

    try {
      for await (const _ of loop.execute(
        [{ role: 'user', content: prompt }],
        SYSTEM_PROMPT,
        { maxIterations, contextMode: 'smart' },
        { cwd: workspace },
      )) { /* drain the headless response */ }
    } catch (error: any) {
      agentError = error?.message ?? String(error);
    } finally {
      cliEvents.off('log', onLog);
      cliEvents.off('status', onStatus);
    }

    const episode = loadEpisode(writer.file());
    if (!episode) throw new Error(`Episode recorder produced no readable bundle for ${manifest.id}.`);
    const measurement = measureEpisodeCalls(episode.calls);
    const persistedEpisodeDir = path.join(
      AUTONOMY_ROOT,
      'results',
      'episodes',
      runId,
      manifest.id,
    );
    await fsp.mkdir(persistedEpisodeDir, { recursive: true });
    const persistedEpisodeFile = path.join(persistedEpisodeDir, path.basename(writer.file()));
    await fsp.copyFile(writer.file(), persistedEpisodeFile);
    const checkSpec = resolveCheck(manifest, taskDir);
    const check = spawnSync(checkSpec.command, checkSpec.args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: manifest.successCheck.timeoutMs ?? 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
      },
    });
    const exitCode = check.status ?? 1;

    return {
      id: manifest.id,
      prompt,
      passed: exitCode === 0,
      ...measurement,
      wallClockMs: Math.round(performance.now() - started),
      contextRecoveryFired,
      completionTokenSource: 'tokenizer-estimate-from-recorded-text-and-tool-calls',
      reasoningTokenSource: 'tokenizer-estimate-from-recorded-thinking',
      ...(agentError ? { agentError } : {}),
      check: {
        command: [manifest.successCheck.command, ...manifest.successCheck.args].join(' '),
        exitCode,
        stdout: String(check.stdout || '').trim(),
        stderr: String(check.stderr || check.error?.message || '').trim(),
      },
      episode: {
        id: episode.header.id,
        chainOk: episode.chainOk,
        file: path.relative(REPO_ROOT, persistedEpisodeFile),
      },
    };
  } finally {
    process.chdir(originalCwd);
    if (oldFloor === undefined) delete process.env.BIMAX_SANDBOX_FLOOR;
    else process.env.BIMAX_SANDBOX_FLOOR = oldFloor;
    await fsp.rm(workspace, { recursive: true, force: true });
  }
}

async function runTaskIsolated(
  taskDir: string,
  mode: RunMode,
  runId: string,
  liveSetup?: LiveProviderSetup,
): Promise<TaskResult> {
  const started = performance.now();
  try {
    return await runTask(taskDir, mode, runId, liveSetup);
  } catch (error: any) {
    const message = error?.stack || error?.message || String(error);
    let id = path.basename(taskDir);
    let prompt = '';
    let checkCommand = '';
    try {
      const manifest = JSON.parse(
        await fsp.readFile(path.join(taskDir, 'task.json'), 'utf8'),
      ) as TaskManifest;
      id = manifest.id || id;
      prompt = (await fsp.readFile(path.join(taskDir, manifest.promptFile), 'utf8')).trim();
      checkCommand = [manifest.successCheck.command, ...manifest.successCheck.args].join(' ');
    } catch { /* retain directory-derived evidence for malformed task definitions */ }

    return {
      id,
      prompt,
      passed: false,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      wallClockMs: Math.round(performance.now() - started),
      contextRecoveryFired: false,
      usageComplete: false,
      completionTokenSource: 'tokenizer-estimate-from-recorded-text-and-tool-calls',
      reasoningTokenSource: 'tokenizer-estimate-from-recorded-thinking',
      crashed: true,
      agentError: message,
      check: {
        command: checkCommand,
        exitCode: 1,
        stdout: '',
        stderr: message,
      },
      episode: { id: '', chainOk: false },
    };
  }
}

interface SourceReportTask {
  id?: string;
  passed?: boolean;
  contextRecoveryFired?: boolean;
  episode?: { id?: string };
}

interface SourceReport {
  runId?: string;
  tasks?: SourceReportTask[];
}

async function readSourceReport(sourceRunId: string): Promise<SourceReport | undefined> {
  const reportFile = path.join(AUTONOMY_ROOT, 'results', `${sourceRunId}.json`);
  try {
    return JSON.parse(await fsp.readFile(reportFile, 'utf8')) as SourceReport;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Could not read source report ${reportFile}: ${error?.message || String(error)}`);
  }
}

async function runRemeasure(episodeRunDir: string): Promise<void> {
  const sourceEpisodeDir = path.resolve(episodeRunDir);
  const sourceRunId = path.basename(sourceEpisodeDir);
  const entries = await fsp.readdir(sourceEpisodeDir, { withFileTypes: true });
  const taskDirs = entries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (taskDirs.length === 0) {
    throw new Error(`No task episode directories found under ${sourceEpisodeDir}.`);
  }

  const sourceReport = await readSourceReport(sourceRunId);
  const sourceTasks = sourceReport?.tasks || [];
  const { loadEpisode } = await import('../../src/mind/episode.recorder');
  const tasks: RemeasuredTaskResult[] = [];

  for (const taskEntry of taskDirs) {
    const taskDir = path.join(sourceEpisodeDir, taskEntry.name);
    const files = (await fsp.readdir(taskDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const fileEntry of files) {
      const episodeFile = path.join(taskDir, fileEntry.name);
      const episode = loadEpisode(episodeFile);
      if (!episode) throw new Error(`Could not load episode bundle ${episodeFile}.`);
      const sourceTask = sourceTasks.find(task => task.episode?.id === episode.header.id) ||
        sourceTasks.find(task => task.id === taskEntry.name);
      const passKnown = typeof sourceTask?.passed === 'boolean';
      const multipleBundles = files.length > 1;
      tasks.push({
        id: multipleBundles ? `${taskEntry.name}:${episode.header.id}` : taskEntry.name,
        taskId: taskEntry.name,
        ...(passKnown ? { passed: sourceTask.passed } : {}),
        passStatus: passKnown ? 'carried-forward-from-source-report' : 'from-episode-unknown',
        ...(typeof sourceTask?.contextRecoveryFired === 'boolean'
          ? { contextRecoveryFired: sourceTask.contextRecoveryFired }
          : {}),
        ...measureEpisodeCalls(episode.calls),
        completionTokenSource: 'tokenizer-estimate-from-recorded-text-and-tool-calls',
        reasoningTokenSource: 'tokenizer-estimate-from-recorded-thinking',
        episode: {
          id: episode.header.id,
          chainOk: episode.chainOk,
          file: path.relative(REPO_ROOT, episodeFile),
        },
      });
    }
  }
  if (tasks.length === 0) throw new Error(`No .jsonl episode bundles found under ${sourceEpisodeDir}.`);

  const completionEligible = tasks.filter(task => typeof task.passed === 'boolean');
  const passed = completionEligible.filter(task => task.passed).length;
  const excludedFromCompletionRate = tasks
    .filter(task => typeof task.passed !== 'boolean')
    .map(task => task.id);
  const recoveryEligible = tasks.filter(task => typeof task.contextRecoveryFired === 'boolean');
  const summary = {
    tasks: tasks.length,
    passed,
    completionRateEligibleTasks: completionEligible.length,
    ...(completionEligible.length > 0
      ? { completionRate: passed / completionEligible.length }
      : {}),
    excludedFromCompletionRate,
    medianTotalTokens: median(tasks.map(task => task.totalTokens)),
    medianTurns: median(tasks.map(task => task.turnCount)),
    sumPromptTokens: tasks.reduce((sum, task) => sum + task.totalPromptTokens, 0),
    sumCompletionTokens: tasks.reduce((sum, task) => sum + task.totalCompletionTokens, 0),
    sumReasoningTokens: tasks.reduce((sum, task) => sum + task.reasoningTokens, 0),
    sumTotalTokens: tasks.reduce((sum, task) => sum + task.totalTokens, 0),
    contextRecoveryRate: recoveryEligible.length > 0
      ? recoveryEligible.filter(task => task.contextRecoveryFired).length / recoveryEligible.length
      : null,
    contextRecoveryEligibleTasks: recoveryEligible.length,
  };
  const startedAt = new Date();
  const runId = `run-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const report = {
    schemaVersion: 1,
    runId,
    mode: 'remeasured',
    sourceRunId,
    sourceEpisodeDirectory: path.relative(REPO_ROOT, sourceEpisodeDir),
    sourceReportFound: sourceReport !== undefined,
    serial: true,
    metricSources: {
      promptTokens: 'provider-reported-usage-from-recorded-response',
      completionTokens: 'tokenizer-estimate-from-recorded-text-and-tool-calls',
      reasoningTokens: 'tokenizer-estimate-from-recorded-thinking',
      totalTokens: 'sum-of-prompt-visible-completion-and-reasoning-tokens',
      passStatus: sourceReport
        ? 'carried-forward-from-source-report'
        : 'from-episode-unknown-excluded-from-completion-rate',
    },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    tasks,
    summary,
  };

  await fsp.mkdir(path.join(AUTONOMY_ROOT, 'results'), { recursive: true });
  const reportFile = path.join(AUTONOMY_ROOT, 'results', `${runId}.json`);
  await fsp.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.table(tasks.map(task => ({
    id: task.id,
    result: task.passed === true ? 'PASS' : task.passed === false ? 'FAIL' : 'UNKNOWN',
    tokens: task.totalTokens,
    turns: task.turnCount,
    recovery: task.contextRecoveryFired ?? 'UNKNOWN',
  })));
  console.log(`REMEASURED: ${sourceRunId} (episodes only — agent and graders were not run)`);
  if (completionEligible.length > 0) {
    console.log(
      `Completion rate (carried forward): ${(passed / completionEligible.length * 100).toFixed(1)}% ` +
      `(${passed}/${completionEligible.length})`,
    );
  } else {
    console.log('Completion rate: unavailable (all pass statuses are from-episode-unknown)');
  }
  if (excludedFromCompletionRate.length > 0) {
    console.log(`Excluded from completion rate: ${excludedFromCompletionRate.join(', ')}`);
  }
  console.log(`Median tokens: ${summary.medianTotalTokens}`);
  console.log(`Median turns: ${summary.medianTurns}`);
  console.log(`Prompt tokens: ${summary.sumPromptTokens}`);
  console.log(`Visible completion tokens: ${summary.sumCompletionTokens}`);
  const outputTokens = summary.sumCompletionTokens + summary.sumReasoningTokens;
  const reasoningPercent = outputTokens > 0 ? summary.sumReasoningTokens / outputTokens * 100 : 0;
  console.log(`Reasoning tokens: ${summary.sumReasoningTokens} (${reasoningPercent.toFixed(1)}% of output)`);
  console.log(`Total tokens: ${summary.sumTotalTokens}`);
  if (summary.contextRecoveryRate === null) {
    console.log('Context recovery rate: unavailable');
  } else {
    console.log(`Context recovery rate: ${(summary.contextRecoveryRate * 100).toFixed(1)}%`);
  }
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const remeasureIndexes = args
    .map((arg, index) => arg === '--remeasure' ? index : -1)
    .filter(index => index >= 0);
  if (remeasureIndexes.length > 0) {
    if (remeasureIndexes.length > 1) throw new Error('--remeasure may only be specified once.');
    const index = remeasureIndexes[0];
    const episodeRunDir = args[index + 1];
    if (!episodeRunDir || episodeRunDir.startsWith('-')) {
      throw new Error('--remeasure requires an episode run directory.');
    }
    const remaining = args.filter((_, argIndex) => argIndex !== index && argIndex !== index + 1);
    if (remaining.length > 0) {
      throw new Error('--remeasure cannot be combined with live, suite, or task arguments.');
    }
    await runRemeasure(episodeRunDir);
    return;
  }
  const live = args.includes('--live') || process.env.BIMAX_AUTONOMY_LIVE === '1';
  const suite = args.includes('--suite');
  const mode: RunMode = live ? 'live' : 'offline-trajectory-smoke';
  const taskArgs = args.filter(arg => arg !== '--live' && arg !== '--suite');
  const unknownFlags = taskArgs.filter(arg => arg.startsWith('-'));
  if (unknownFlags.length > 0) throw new Error(`Unknown option: ${unknownFlags[0]}`);
  if (suite && taskArgs.length > 0) throw new Error('--suite does not accept an individual task path.');
  if (taskArgs.length > 1) throw new Error('This disk-light runner accepts one task per invocation (serial only).');
  const taskDirs = suite
    ? await discoverSuiteTasks()
    : [path.resolve(taskArgs[0] || DEFAULT_TASK)];
  if (taskDirs.length === 0) throw new Error('No autonomy task directories were found.');
  const suiteLogRoot = suite ? await createSuiteLogAnchor() : undefined;
  try {
    const liveSetup = live ? await createLiveProvider() : undefined;
    const startedAt = new Date();
    const runId = `run-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
    const tasks: TaskResult[] = [];
    // Deliberately serial: each task fully provisions, runs, checks, and tears down before the next.
    for (const taskDir of taskDirs) {
      tasks.push(await runTaskIsolated(taskDir, mode, runId, liveSetup));
    }
    const finishedAt = new Date();
    const passed = tasks.filter(task => task.passed).length;
    const measuredCompletionRate = passed / tasks.length;
    const contextRecoveryRate = tasks.filter(task => task.contextRecoveryFired).length / tasks.length;
    const summary = {
      tasks: tasks.length,
      passed,
      ...(live
        ? { completionRate: measuredCompletionRate }
        : { pipelineSmokePassed: passed === tasks.length }),
      medianTotalTokens: median(tasks.map(task => task.totalTokens)),
      medianTurns: median(tasks.map(task => task.turnCount)),
      sumPromptTokens: tasks.reduce((sum, task) => sum + task.totalPromptTokens, 0),
      sumCompletionTokens: tasks.reduce((sum, task) => sum + task.totalCompletionTokens, 0),
      sumReasoningTokens: tasks.reduce((sum, task) => sum + task.reasoningTokens, 0),
      sumTotalTokens: tasks.reduce((sum, task) => sum + task.totalTokens, 0),
      contextRecoveryRate,
    };
    const report = {
      schemaVersion: 1,
      runId,
      mode,
      serial: true,
      metricSources: {
        promptTokens: live ? 'provider-reported-usage' : 'offline-tokenizer-estimate',
        completionTokens: 'tokenizer-estimate-from-recorded-text-and-tool-calls',
        reasoningTokens: 'tokenizer-estimate-from-recorded-thinking',
        totalTokens: 'sum-of-prompt-visible-completion-and-reasoning-tokens',
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      tasks,
      summary,
    };

    await fsp.mkdir(path.join(AUTONOMY_ROOT, 'results'), { recursive: true });
    const reportFile = path.join(AUTONOMY_ROOT, 'results', `${runId}.json`);
    await fsp.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

    console.table(tasks.map(task => ({
      id: task.id,
      result: task.passed ? 'PASS' : 'FAIL',
      tokens: task.totalTokens,
      turns: task.turnCount,
      recovery: task.contextRecoveryFired,
    })));
    if (live) {
      console.log(`Completion rate: ${(measuredCompletionRate * 100).toFixed(1)}% (${passed}/${tasks.length})`);
    } else {
      console.log(
        `PIPELINE SMOKE: ${passed === tasks.length ? 'PASS' : 'FAIL'} ` +
        `(${passed}/${tasks.length} scripted trajectories — NOT an autonomy measure)`,
      );
    }
    console.log(`Median tokens: ${summary.medianTotalTokens}`);
    console.log(`Median turns: ${summary.medianTurns}`);
    console.log(`Visible completion tokens: ${summary.sumCompletionTokens}`);
    const outputTokens = summary.sumCompletionTokens + summary.sumReasoningTokens;
    const reasoningPercent = outputTokens > 0 ? summary.sumReasoningTokens / outputTokens * 100 : 0;
    console.log(`Reasoning tokens: ${summary.sumReasoningTokens} (${reasoningPercent.toFixed(1)}% of output)`);
    console.log(`Total tokens: ${summary.sumTotalTokens}`);
    console.log(`Context recovery rate: ${(summary.contextRecoveryRate * 100).toFixed(1)}%`);
    console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
    if (passed !== tasks.length) process.exitCode = 1;
  } finally {
    if (suiteLogRoot) await fsp.rm(suiteLogRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
