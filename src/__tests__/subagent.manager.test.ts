import { SubAgentManager } from '../core/subagent.manager';
import { globalSubAgentBlackboard } from '../core/subagent.blackboard';
import { engineEvents, ToolCallEntry } from '../engine/events';
import { createWorktree } from '../core/worktree.manager';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('SubAgentManager — worker watchdog timeout', () => {
  let dir: string;
  let hangScript: string;
  let quickScript: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-worker-'));
    // A worker that never posts a message and never exits.
    hangScript = path.join(dir, 'hang.js');
    fs.writeFileSync(hangScript, 'setInterval(() => {}, 1000);\n');
    // A worker that immediately reports success.
    quickScript = path.join(dir, 'quick.js');
    fs.writeFileSync(quickScript, "const { parentPort } = require('worker_threads'); parentPort.postMessage({ type: 'success', result: 'ok' });\n");
  });

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const cfg = { agentType: 'test', prompt: 'x', cwd: os.tmpdir(), parentMode: 'safe' };

  // Regression: sub-agents crashed at module load ("Cannot find package 'minimatch'") because the
  // worker ran the TypeScript source with a tsx loader that doesn't propagate into worker threads.
  // The default entry must resolve to a COMPILED .js worker with no TS-loader execArgv.
  it('defaults to a compiled .js worker entry with no tsx loader', () => {
    const mgr = new SubAgentManager() as any;
    expect(mgr.workerScriptPath.endsWith('.js')).toBe(true);
    expect(mgr.workerExecArgv).toEqual([]);
  });

  it('terminates and rejects a worker that exceeds the timeout', async () => {
    const mgr = new SubAgentManager({ workerScriptPath: hangScript, timeoutMs: 300 });
    const start = Date.now();
    await expect(mgr.spawnWorker('t-hang', cfg)).rejects.toThrow(/timed out/i);
    // Rejected promptly (not left hanging) and the worker was cleaned up.
    expect(Date.now() - start).toBeLessThan(3000);
    expect(mgr.activeCount()).toBe(0);
  });

  it('resolves a healthy worker and clears the watchdog (no late rejection)', async () => {
    const mgr = new SubAgentManager({ workerScriptPath: quickScript, timeoutMs: 5000 });
    await expect(mgr.spawnWorker('t-ok', cfg)).resolves.toMatchObject({
      version: 1, taskId: 't-ok', report: 'ok', observedChangedFiles: [],
    });
    expect(mgr.activeCount()).toBe(0);
    // Give any (incorrectly uncleared) timer a chance to fire — it must not.
    await new Promise(r => setTimeout(r, 50));
  });

  // Regression: after a timeout, terminate() fires an 'exit' event. The exit handler used to run
  // its side-effects unconditionally, overwriting the board's "timed out after Nms" reason with
  // "worker exited with code N". The settled-guard must keep the real (timeout) reason.
  it('keeps the timeout reason on the board after the terminate-driven exit fires', async () => {
    const mgr = new SubAgentManager({ workerScriptPath: hangScript, timeoutMs: 200 });
    await expect(mgr.spawnWorker('t-clobber', cfg)).rejects.toThrow(/timed out/i);
    // Let the exit event (from terminate) land — the guard must suppress its board write.
    await new Promise(r => setTimeout(r, 150));
    const claim = globalSubAgentBlackboard.all().find(c => c.taskId === 't-clobber');
    expect(claim?.status).toBe('failed');
    expect(claim?.error).toMatch(/timed out/i);
    expect(claim?.error).not.toMatch(/exited with code/i);
  });
});

describe('SubAgentManager — T3 sub-agent tool-event relay', () => {
  let dir: string;
  let toolScript: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-relay-'));
    toolScript = path.join(dir, 'tool.js');
    // A worker that forwards one tool_call event, then reports success.
    fs.writeFileSync(toolScript,
      "const { parentPort } = require('worker_threads');\n" +
      "parentPort.postMessage({ type: 'tool_event', subtype: 'tool_call', call: { id: 'c1', toolName: 'BashTool', input: 'ls', output: '', status: 'running', startTime: new Date() } });\n" +
      "parentPort.postMessage({ type: 'tool_event', subtype: 'tool_call_result', call: { id: 'c1', toolName: 'BashTool', input: 'ls', output: 'done', status: 'success', startTime: new Date(), endTime: new Date() } });\n" +
      "parentPort.postMessage({ type: 'success', result: 'ok' });\n");
  });

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('re-emits forwarded tool events on the main bus, tagged with parentId + agentLabel', async () => {
    const calls: ToolCallEntry[] = [];
    const results: ToolCallEntry[] = [];
    const onCall = (c: ToolCallEntry) => calls.push(c);
    const onResult = (c: ToolCallEntry) => results.push(c);
    engineEvents.on('tool_call', onCall);
    engineEvents.on('tool_call_result', onResult);
    try {
      const mgr = new SubAgentManager({ workerScriptPath: toolScript, timeoutMs: 5000 });
      await mgr.spawnWorker('t-relay', { agentType: 'Hermes', prompt: 'x', cwd: os.tmpdir(), parentMode: 'safe' });
    } finally {
      engineEvents.off('tool_call', onCall);
      engineEvents.off('tool_call_result', onResult);
    }

    const tagged = calls.find(c => c.id === 'c1');
    expect(tagged).toBeDefined();
    expect(tagged!.parentId).toBe('t-relay');
    expect(tagged!.agentLabel).toBe('Hermes');
    expect(results.find(c => c.id === 'c1')?.status).toBe('success');
  });
});

describe('SubAgentManager — crash-surviving worktree recovery', () => {
  it('reopens the exact checkpointed worktree and preserves its partial edits', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-recovery-wt-')));
    const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-recovery-worker-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@bimax'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' });
      const wt = createWorktree(repo, 'subagent-recovery1')!;
      fs.writeFileSync(path.join(wt.path, 'a.txt'), 'partial work survived\n');
      const worker = path.join(workerDir, 'success.js');
      fs.writeFileSync(worker, "const { parentPort } = require('worker_threads'); parentPort.postMessage({ type: 'success', result: 'continued' });\n");

      const manager = new SubAgentManager({ workerScriptPath: worker, timeoutMs: 5000 });
      const result = await manager.spawnWorker('subagent-replacement', {
        agentType: 'BiMax', prompt: 'continue', cwd: wt.path, parentMode: 'default',
        scope: 'a.txt', outcomeTaskId: 'build', outcomeSessionId: 'session-1',
        isolation: 'worktree', isolationRequired: true, recoveryWorktree: wt, recoveryOf: 'subagent-recovery1',
      });
      expect(result.observedChangedFiles).toEqual(['a.txt']);
      expect(result.isolation).toMatchObject({ path: wt.path, branch: wt.branch, baseCommit: wt.baseCommit });
      expect(fs.readFileSync(path.join(wt.path, 'a.txt'), 'utf8')).toBe('partial work survived\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(workerDir, { recursive: true, force: true });
    }
  });
});
