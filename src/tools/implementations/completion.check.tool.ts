import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { engineEvents } from '../../engine/events';
import { describeCheck, getCompletionChecks, parseChecks } from '../../outcome/completion.check';

/**
 * CompletionCheckTool (backlog F3): the model states how a task that changes files will be checked, and Bimax runs
 * the check itself when the task finishes. The user sees the check as it is set and can change it or ask for none.
 */
export const createCompletionCheckTool = (governor: IGovernor) => buildTool({
  name: 'CompletionCheckTool',
  description: `State how this task's result will be checked. Bimax runs the checks itself when you finish, and the task is not done until they pass.

- action "set": one or more checks. kind "command" — a command that must exit 0, such as the project's tests or build (\`npm test\`, \`pytest -q\`, \`cargo build\`). kind "file" — a file that must exist, optionally containing some text. kind "json" — a file that must be valid JSON. Paths are relative to the task's folder.
- action "skip": when nothing meaningful can be checked; give the reason.
- action "status": the checks and their last result.

Pick a check that proves the user's request, not one that is easy to pass. Never edit the tests a check runs to make it pass; if a test is wrong, tell the user. A check that failed cannot be changed or skipped in the same turn.`,
  isDestructive: false,
  isConcurrencySafe: false,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'skip', 'status'], description: 'What to do.' },
      checks: {
        type: 'array',
        description: 'For "set": the checks that must all pass.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['command', 'file', 'json'], description: 'What sort of check this is.' },
            command: { type: 'string', description: 'For kind "command": the command that must exit 0.' },
            path: { type: 'string', description: 'For kind "file" or "json": the file, relative to the task folder.' },
            contains: { type: 'string', description: 'For kind "file": text the file must contain (optional).' },
          },
          required: ['kind'],
        },
      },
      reason: { type: 'string', description: 'For "skip": why nothing meaningful can be checked.' },
    },
    required: ['action'],
  },
  execute: async (args: { action: 'set' | 'skip' | 'status'; checks?: unknown; reason?: string }) => {
    const runtime = getCompletionChecks();
    if (!runtime) return 'Completion checks are not available in this engine.';
    const tell = (content: string): void => {
      try { engineEvents.emit('message', { id: `check-${Date.now()}`, role: 'system', level: 'info', content, timestamp: new Date() }); } catch { /* best-effort */ }
    };
    if (args.action === 'status') {
      const snapshot = runtime.snapshot();
      if (!snapshot.checks.length) return snapshot.skipped ? `No check: skipped (${snapshot.skipped}).` : 'No completion check is set.';
      const results = snapshot.results.map((r) => `- ${describeCheck(r.check)}: ${r.ok ? 'passed' : 'failed'} — ${r.detail.slice(0, 300)}`);
      return [`State: ${snapshot.state}`, ...snapshot.checks.map((c) => `- ${describeCheck(c)}`), ...(results.length ? ['Last run:', ...results] : [])].join('\n');
    }
    if (args.action === 'skip') {
      const refused = runtime.skip(args.reason ?? '');
      if (refused) throw new Error(`The check was not skipped: ${refused}.`);
      tell(`No completion check for this task: ${args.reason?.trim() || 'no reason given'}. It will show as finished but not checked.`);
      return 'Skipped. The task will be reported as finished but not checked.';
    }
    const parsed = parseChecks(args.checks);
    if ('error' in parsed) throw new Error(`The check was not set: ${parsed.error}.`);
    const refused = runtime.set(parsed.checks);
    if (refused) throw new Error(`The check was not changed: ${refused}.`);
    const said = parsed.checks.map(describeCheck).join('; ');
    tell(`Completion check: ${said}. Bimax runs it when the task finishes — say so if you want a different check or none.`);
    return `Set. When you finish, Bimax runs: ${said}. The task is not done until it passes.`;
  },
}, governor);
