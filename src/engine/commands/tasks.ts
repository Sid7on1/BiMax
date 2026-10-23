import { globalCommandRegistry } from './registry';

// /tasks — the task-workspace control surface (task.registry.ts + execution.ledger.ts).
// Lists live and recent background tasks (shell, browser, builds), inspects bounded output,
// and drives the honest action set: cancel always; pause/resume only where the underlying
// process really supports it (SIGSTOP/SIGCONT); retry re-CREATES failed-resumable work from
// its recorded command — it never pretends a dead process continued.

const STATE_ICON: Record<string, string> = {
  'queued': '·', 'starting': '◌', 'running': '◍', 'streaming': '◍',
  'waiting-model': '◔', 'waiting-tool': '◔', 'waiting-browser': '◔', 'waiting-user': '⚑',
  'retrying': '↻', 'recovering': '↻', 'paused': '⏸', 'cancelling': '⏹',
  'cancelled': '⏹', 'completed': '✓', 'failed': '✗', 'failed-resumable': '✗',
};

function fmtElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

globalCommandRegistry.register({
  name: '/tasks',
  description: 'Task workspaces — list, inspect, cancel, pause/resume, retry background tasks',
  category: 'Session & Context',
  execute: async (args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTaskRegistry } = require('../../core/task.registry') as typeof import('../../core/task.registry');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getExecutionLedger } = require('../../core/execution.ledger') as typeof import('../../core/execution.ledger');
    const reg = getTaskRegistry();
    const sub = (args[0] || '').toLowerCase();
    const id = args[1] || '';

    const msg = (content: string, level: 'info' | 'error' | 'success' = 'info') => ({ type: 'message' as const, level, content });

    if (!sub || sub === 'list') {
      const tasks = reg.list();
      // Tasks from a PREVIOUS process: still-open ones (crash before boot marking) plus ones the
      // boot pass already marked failed-resumable. Cleared with /tasks clear.
      const interrupted = getExecutionLedger().reconstruct()
        .filter(t => (t.state === 'failed-resumable' || !['cancelled', 'completed', 'failed'].includes(t.state)) && !reg.find(t.taskId))
        .slice(-5);
      if (tasks.length === 0 && interrupted.length === 0) {
        return msg('● **Tasks**\n\n  No background tasks this session. Long shell work runs with `background: true`; a live browser session appears here automatically.');
      }
      const lines = ['● **Tasks**', ''];
      for (const t of tasks) {
        const acts = [
          t.supports.cancel && !['cancelled', 'completed', 'failed', 'failed-resumable'].includes(t.state) ? 'cancel' : '',
          t.supports.pause && (t.state === 'running' || t.state === 'streaming') ? 'pause' : '',
          t.state === 'paused' ? 'resume' : '',
          t.state === 'failed-resumable' ? 'retry' : '',
          ['cancelled', 'completed', 'failed', 'failed-resumable'].includes(t.state) ? 'close' : '',
        ].filter(Boolean).join('/');
        lines.push(`  ${STATE_ICON[t.state] || '·'} \`${t.id}\` **${t.title}** — ${t.state}${t.pinned ? ' ⚲' : ''} · ${t.kind} · ${fmtElapsed((t.endedAt || Date.now()) - (t.startedAt || t.createdAt))}${acts ? ` · ${acts}` : ''}`);
        if (t.lastEvent) lines.push(`     ${t.lastEvent}`);
        if (t.failure) lines.push(`     ✗ ${t.failure}`);
      }
      if (interrupted.length) {
        lines.push('', '  **Interrupted in a previous session** (ledger):');
        for (const t of interrupted) {
          lines.push(`  ✗ \`${t.taskId}\` ${t.title} — was ${t.state}${t.resumable ? ` · retry with \`/tasks retry ${t.taskId}\`` : ' · not re-creatable'}`);
        }
      }
      return msg(lines.join('\n'));
    }

    if (sub === 'show') {
      const t = reg.find(id);
      if (!t) return msg(`No task ${id || '(missing id)'} — run /tasks for the list.`, 'error');
      reg.seen(t.id);
      const out = reg.output(t.id, 60);
      return msg([
        `● **${t.title}** \`${t.id}\``,
        '',
        `  state: ${t.state} · kind: ${t.kind} · retries: ${t.retries}${t.exitCode !== undefined ? ` · exit: ${t.exitCode}` : ''}`,
        t.command ? `  command: \`${t.command.slice(0, 160)}\`` : '',
        t.failure ? `  failure: ${t.failure}` : '',
        '',
        out ? '```\n' + out + '\n```' : '  (no captured output)',
      ].filter(Boolean).join('\n'));
    }

    if (sub === 'cancel') return msg(reg.cancel(id));
    if (sub === 'pause') return msg(reg.pause(id));
    if (sub === 'resume') return msg(reg.resume(id));
    if (sub === 'pin') return msg(reg.pin(id));
    if (sub === 'close') return msg(reg.close(id));

    if (sub === 'retry') {
      // Live failed-resumable task, or an interrupted task from a previous process (ledger).
      const live = reg.find(id);
      const record = live
        ? (live.command && live.cwd ? { command: live.command, cwd: live.cwd, title: live.title } : null)
        : (() => {
            const t = getExecutionLedger().reconstruct().find(r => r.taskId === id || r.taskId.startsWith(id));
            return t && t.resumable ? { command: t.command!, cwd: t.cwd!, title: t.title } : null;
          })();
      if (!record) return msg(`Task ${id} has no recorded command to re-run — it is not resumable.`, 'error');
      if (live && !['failed-resumable', 'cancelled', 'failed'].includes(live.state)) {
        return msg(`${live.title} is ${live.state} — retry applies to failed tasks.`, 'error');
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { rerunShellTask } = require('../../core/shell.tasks') as typeof import('../../core/shell.tasks');
      const { task } = rerunShellTask(record.command, record.cwd, record.title);
      if (live) reg.retry(live.id, undefined);
      return msg(`↻ Re-created as \`${task.id}\`: ${record.title}`);
    }

    if (sub === 'clear') {
      const dropped = getExecutionLedger().clearCompleted();
      let closed = 0;
      for (const t of reg.list()) {
        if (['cancelled', 'completed', 'failed', 'failed-resumable'].includes(t.state)) { reg.close(t.id); closed++; }
      }
      return msg(`Cleared ${closed} finished task(s) from the panel and ${dropped} ledger record(s).`);
    }

    return msg('Usage: /tasks [list | show <id> | cancel <id> | pause <id> | resume <id> | retry <id> | pin <id> | close <id> | clear]', 'info');
  },
});
