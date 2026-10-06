import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../core/agent.loop';
import { LLMProvider, Message, ChatEvent } from '../core/llm.provider';
import { EpisodeWriter, RecordingProvider, listEpisodes } from '../mind/episode.recorder';
import { replayEpisode } from '../mind/replay.harness';
import { engineEvents } from '../engine/events';
import { SessionRecorder } from '../engine/session.recorder';
import { sessionDir } from '../engine/session';
import { ProtocolHost } from '../protocol/host';
import { ThreadManager } from '../../app/src/main/thread.manager';
import { appStore } from '../state/app.state';
import { clearSteer, pushSteer, drainSteer } from '../core/steering';
import { taskMetrics } from '../telemetry/task.metrics';
import { getTaintTracker } from '../mind/taint';
import { CompletionChecks, __setCompletionChecks } from '../outcome/completion.check';

/** Scripted provider: one pre-baked event stream per chat() call, in order. */
function scripted(streams: ChatEvent[][]): LLMProvider {
  let call = 0;
  return {
    async *chat(): AsyncGenerator<ChatEvent> {
      const events = streams[call++] || [{ type: 'token', text: 'out of script' }, { type: 'done' } as ChatEvent];
      for (const ev of events) yield ev;
    },
  };
}

/** Minimal real-shaped registry for the RECORDING run: one Bash-ish tool with a fixed result. */
function liveRegistry(toolName = 'ListTool') {
  return {
    getSchemas: () => [{ type: 'function', function: { name: toolName, parameters: { type: 'object', properties: {} } } }],
    getTool: (name: string) => name === toolName
      ? { name, isConcurrencySafe: false, execute: async () => 'a.ts\nb.ts' }
      : undefined,
  };
}

const SYSTEM = 'you are bimax, terse';

describe('Replay harness (v2 Phase 4 — re-run recorded episodes, divergence reports)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-replay-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Record a real 2-call episode: model asks for ListTool, then answers with text. */
  async function recordEpisode(toolName = 'ListTool'): Promise<string> {
    const streams: ChatEvent[][] = [
      [
        { type: 'tool_call', id: 'c1', name: toolName, args: '{}' },
        { type: 'done' },
      ],
      [
        { type: 'token', text: 'Two files: a.ts and b.ts.' },
        { type: 'done' },
      ],
    ];
    const writer = new EpisodeWriter(dir);
    const recording = new RecordingProvider(scripted(streams), writer);
    const loop = new AgentLoop(recording, liveRegistry(toolName) as any);
    const initial: Message[] = [{ role: 'user', content: 'what files are here?' }];
    let text = '';
    for await (const chunk of loop.execute(initial, SYSTEM, { maxIterations: 4 })) text += chunk;
    expect(text).toContain('Two files');
    return writer.id;
  }

  it('replays an unchanged harness bit-for-bit — the determinism gate', async () => {
    const id = await recordEpisode();

    const report = await replayEpisode(id, { root: dir });
    if ('error' in report) throw new Error(report.error);

    expect(report.callsRecorded).toBe(2);
    expect(report.callsServed).toBe(2);
    expect(report.divergences).toEqual([]);
    expect(report.toolResultsMissing).toBe(0);
    expect(report.systemChanged).toBe(false);
    expect(report.identical).toBe(true);
    expect(report.finalText).toContain('Two files: a.ts and b.ts.');
  });

  it('reports the exact divergence point when the system prompt changes', async () => {
    const id = await recordEpisode();

    const report = await replayEpisode(id, { root: dir, systemPrompt: 'you are bimax, VERBOSE' });
    if ('error' in report) throw new Error(report.error);

    expect(report.systemChanged).toBe(true);
    expect(report.identical).toBe(false);
    // Every request embeds the system prompt, so both calls diverge — starting at #0.
    expect(report.divergences.length).toBeGreaterThanOrEqual(1);
    expect(report.divergences[0].idx).toBe(0);
    // In-order fallback still drives the run to completion on recorded responses.
    expect(report.callsServed).toBe(2);
    expect(report.finalText).toContain('Two files');
  });

  it('a replay does not record a new episode of itself', async () => {
    const id = await recordEpisode();
    const before = listEpisodes(dir).length;
    await replayEpisode(id, { root: dir });
    expect(listEpisodes(dir).length).toBe(before);
  });

  it('refuses to replay a tampered bundle', async () => {
    const id = await recordEpisode();
    const file = path.join(dir, '.bimax', 'episodes', `${id}.jsonl`);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    lines[1] = lines[1].replace('what files are here?', 'rm -rf everything');
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const report = await replayEpisode(id, { root: dir });
    expect('error' in report && /tampered/i.test((report as any).error)).toBe(true);
  });

  it('keeps old replay cards out of a fresh desktop chat, appStore and persisted session', async () => {
    const id = await recordEpisode();
    const previousStateDir = process.env.BIMAX_STATE_DIR;
    process.env.BIMAX_STATE_DIR = dir;
    const recorder = new SessionRecorder();
    const onMessage = recorder.onMessage.bind(recorder), onTool = recorder.onToolResult.bind(recorder);
    const desktop = new ThreadManager({ engine: () => ({ openProject: jest.fn(), sendFromRenderer: jest.fn(), dispose: jest.fn() }),
      selected: jest.fn(), message: jest.fn(), approval: jest.fn(), save: jest.fn(), changed: jest.fn() });
    const fresh = desktop.openProject(dir);
    const wire: any[] = [];
    const host = new ProtocolHost(line => { wire.push(line); desktop.receive(fresh, line); });
    engineEvents.on('message', onMessage); engineEvents.on('tool_call_result', onTool); host.attach(engineEvents);
    try {
      engineEvents.emit('message', { id: 'fresh-user', role: 'user', content: 'hi', timestamp: new Date() });
      const file = path.join(sessionDir(), `${recorder.currentId()}.jsonl`);
      const beforeFile = fs.readFileSync(file, 'utf8'), beforeStore = appStore.getState();
      const beforeWire = wire.length;
      const report = await replayEpisode(id, { root: dir });
      expect(report).toMatchObject({ identical: true });
      expect(wire.slice(beforeWire)).toEqual([]);
      expect(appStore.getState()).toBe(beforeStore);
      expect(fs.readFileSync(file, 'utf8')).toBe(beforeFile);
      engineEvents.emit('message', { id: 'fresh-answer', role: 'assistant', content: 'Hello!', timestamp: new Date() });
      expect(desktop.get(fresh).state.items.map(item => item.kind === 'msg' ? item.msg.content : 'OLD TOOL')).toEqual(['hi', 'Hello!']);
      expect(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).content)).toEqual(['hi', 'Hello!']);
    } finally {
      host.detach(); engineEvents.off('message', onMessage); engineEvents.off('tool_call_result', onTool);
      recorder.shutdown();
      if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR; else process.env.BIMAX_STATE_DIR = previousStateDir;
    }
  });

  it('does not consume live steering or finish/count the live task', async () => {
    const id = await recordEpisode();
    taskMetrics.reset(); taskMetrics.begin('foreground'); taskMetrics.recordTurn();
    pushSteer('live follow-up');
    try {
      const report = await replayEpisode(id, { root: dir });
      expect('identical' in report && report.identical).toBe(true);
      expect(drainSteer()).toEqual(['live follow-up']);
      expect(taskMetrics.isRecording).toBe(true);
      expect(taskMetrics.end()).toMatchObject({ label: 'foreground', turns: 1, toolCalls: 0 });
    } finally { clearSteer(); taskMetrics.reset(); }
  });

  it.each(['ReadFileTool', 'EditFileTool'])('replaying %s cannot taint live context or alter/execute live checks', async toolName => {
    const id = await recordEpisode(toolName);
    getTaintTracker().clear('fixture');
    const checks = new CompletionChecks({ sessionId: () => 'foreground', directory: () => dir });
    checks.beginTurn(); checks.set([{ kind: 'command', command: 'touch replay-must-not-run' }]);
    const before = checks.snapshot(), settle = jest.spyOn(checks, 'settle');
    __setCompletionChecks(checks);
    try {
      const report = await replayEpisode(id, { root: dir });
      expect('identical' in report && report.identical).toBe(true);
      expect(getTaintTracker().isTainted()).toBe(false);
      expect(checks.snapshot()).toEqual(before);
      expect(settle).not.toHaveBeenCalled();
    } finally { __setCompletionChecks(null); getTaintTracker().clear('cleanup'); }
  });
});
