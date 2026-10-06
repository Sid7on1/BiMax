import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { sandboxArgv, sandboxBin, floorArgv, floorRoot, floorChildEnv, floorBlockedReason, sovereignShellBlockedReason } from '../sandbox/exec.sandbox';
import { guiAutomationRefusal } from '../tools/gui.automation.guard';
import type { SpanContext } from '../telemetry/trace';
import { beginBackgroundEvidence } from '../mind/background.evidence';
import { engineEvents } from '../engine/events';
import { getTaskRegistry, WorkspaceTask } from './task.registry';

// ─── Background shell tasks ─────────────────────────────────────────────────────────────────────
// Long-running shell work promoted out of the synchronous BashTool path into a task workspace:
// spawned with its own process group, output captured into the registry's bounded ring buffer,
// lifecycle tracked through the task state machine (and therefore the execution ledger). Pause and
// resume are REAL (SIGSTOP/SIGCONT on the process group) — exactly the honesty rule from
// docs/TASK_WORKSPACES.md. Zellij's resurrection model applies on restart: a dead task is never
// "still running"; it is failed-resumable with the command + cwd recorded so re-running is one action.

export interface ShellTaskResult {
  task: WorkspaceTask;
  summary: string;
}

// Cancellation gives cooperative cleanup one second, then bounds an ignored SIGTERM.
const CANCEL_GRACE_MS = 1000;

export function startShellTask(command: string, opts: { cwd?: string; title?: string; timeoutMs?: number; learningOrigin?: SpanContext } = {}): ShellTaskResult {
  const registry = getTaskRegistry();
  const cwd = opts.cwd || process.cwd();
  const title = (opts.title || command).slice(0, 60);
  let evidence: ReturnType<typeof beginBackgroundEvidence>;
  try { evidence = beginBackgroundEvidence(command, cwd, opts.learningOrigin); } catch { /* optional observer */ }

  // A spawn that fails — sync throw (fork EAGAIN, injected fault) or async 'error' — must land
  // the task in failed-resumable with the command recorded, never wedge it or escape the caller.
  let child: ReturnType<typeof spawn>;
  try {
    require('./fault.injection').faultPoint('shell.spawn');
    // detached → own process group, so signals reach the whole pipeline (`a | b`), not just the shell.
    const gui = guiAutomationRefusal(command);
    const blocked = floorBlockedReason() || sovereignShellBlockedReason() || (gui.refused ? gui.reason : null);
    if (blocked) throw new Error(blocked);
    const argv = floorArgv(command) ?? sandboxArgv(command, cwd);
    const bin = argv ? sandboxBin() : '/bin/bash';
    if (!bin) throw new Error('Sandbox executable unavailable.');
    child = spawn(bin, argv ?? ['-c', command], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...((floorRoot() || process.env.BIMAX_THREAD_ROOT) ? floorChildEnv() : process.env),
        NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0', CLICOLOR_FORCE: '0' },
    });
  } catch (e: any) {
    const task = registry.create({ kind: 'shell', title, command, cwd });
    registry.transition(task.id, 'starting', 'spawning');
    registry.transition(task.id, 'failed-resumable', `spawn error: ${e?.message || e}`);
    try { evidence?.finish(task.id, null, false); } catch { /* observer */ }
    notifyDone(task.id);
    return { task, summary: `Background task ${task.id} failed to start: ${e?.message || e}. Retry with /tasks retry ${task.id}.` };
  }

  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (closed || !child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* gone */ } }
  };
  const task = registry.create({
    kind: 'shell', title, command, cwd,
    handle: {
      cancel: () => {
        signalGroup('SIGTERM');
        // A stopped process cannot handle a pending SIGTERM until it is resumed.
        signalGroup('SIGCONT');
        if (!closed && !killTimer) {
          killTimer = setTimeout(() => signalGroup('SIGKILL'), CANCEL_GRACE_MS);
          killTimer.unref?.();
        }
      },
      pause: () => { process.kill(-child.pid!, 'SIGSTOP'); },
      resume: () => { process.kill(-child.pid!, 'SIGCONT'); },
    },
  });

  registry.transition(task.id, 'starting', `spawned pid ${child.pid}`);
  registry.transition(task.id, 'running');

  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const append = (text: string, channel: 'stdout' | 'stderr') => {
    if (!text) return;
    try { evidence?.append(text, channel); } catch { /* optional observer */ }
    registry.appendStreamOutput(task.id, text, channel);
    registry.touch(task.id, { lastEvent: lastLine(text) });
  };
  child.stdout?.on('data', (d: Buffer) => append(decoders.stdout.write(d), 'stdout'));
  child.stderr?.on('data', (d: Buffer) => append(decoders.stderr.write(d), 'stderr'));

  // Optional wall-clock bound — a background task is not licence for a zombie.
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      const t = registry.get(task.id);
      if (t && (t.state === 'running' || t.state === 'streaming' || t.state === 'paused')) {
        registry.appendOutput(task.id, `\n[bimax] timeout after ${Math.round(opts.timeoutMs! / 1000)}s — sending SIGTERM`);
        registry.cancel(task.id);
      }
    }, opts.timeoutMs);
    timer.unref?.();
  }

  let spawnFailed = false;
  child.on('error', (e) => {
    if (closed) return;
    closed = true;
    spawnFailed = true;
    try { evidence?.finish(task.id, null, false); } catch { /* observer must not break lifecycle */ }
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    const t = registry.get(task.id);
    if (t && t.state !== 'failed') registry.transition(task.id, 'failed-resumable', `spawn error: ${e.message}`);
    notifyDone(task.id);
  });

  // 'close' follows drained stdout/stderr; 'exit' alone is not complete evidence.
  child.on('close', (code, signal) => {
    if (spawnFailed || closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    append(decoders.stdout.end(), 'stdout');
    append(decoders.stderr.end(), 'stderr');
    const t = registry.get(task.id);
    if (!t) return;
    t.exitCode = code ?? undefined;
    try { evidence?.finish(task.id, code, t.state !== 'cancelling' && signal === null); } catch { /* observer */ }
    if (t.state === 'cancelling') {
      registry.transition(task.id, 'cancelled', signal ? `terminated (${signal})` : `cancelled (exit ${code})`);
    } else if (code === 0) {
      registry.transition(task.id, 'completed', 'exit 0');
    } else {
      // Non-zero exit on a re-runnable command: failed but resumable — /tasks retry re-creates it.
      registry.transition(task.id, 'failed-resumable', signal ? `killed by ${signal}` : `exit ${code}`);
    }
    notifyDone(task.id);
  });

  return { task, summary: `Started background task ${task.id} — inspect with /tasks, cancel with /tasks cancel ${task.id}.` };
}

/** Re-run a previously recorded (failed/interrupted) shell task from its ledger record. */
export function rerunShellTask(command: string, cwd: string, title?: string): ShellTaskResult {
  return startShellTask(command, { cwd, title });
}

function lastLine(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.slice(trimmed.lastIndexOf('\n') + 1, trimmed.lastIndexOf('\n') + 121);
}

function notifyDone(taskId: string): void {
  const t = getTaskRegistry().get(taskId);
  if (!t) return;
  const dur = t.endedAt && t.startedAt ? `${Math.round((t.endedAt - t.startedAt) / 1000)}s` : '';
  const text = t.state === 'completed'
    ? `✔ Background task finished (${dur}): ${t.title}`
    : t.state === 'cancelled'
      ? `⏹ Background task cancelled: ${t.title}`
      : `✘ Background task ${t.state === 'failed-resumable' ? 'failed (resumable)' : 'failed'}: ${t.title} — ${t.failure || ''} (last output via /tasks show ${t.id})`;
  try {
    engineEvents.emit('message', {
      id: `task-${taskId}-${Date.now()}`, role: 'system',
      level: t.state === 'completed' ? 'info' : 'warn',
      content: text, timestamp: new Date(),
    });
  } catch { /* front-end optional */ }
}
