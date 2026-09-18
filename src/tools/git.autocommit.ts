import { execFileSync } from 'child_process';
import { isGitRepo } from '../engine/git';
import { Logger } from '../utils/logger';

// B1 (opt-in) — auto-commit each successful edit, Aider-style. Off by default; toggled via
// `/autocommit on|off`. Implemented as a PostToolUse hook (A2) registered only in the
// interactive boot, so workers/print never auto-commit. A throwing commit is swallowed by
// the hook runner, so a non-repo / empty-diff never breaks the turn.

let enabled = false;
export function setGitAutoCommitEnabled(v: boolean): void { enabled = v; }
export function isGitAutoCommitEnabled(): boolean { return enabled; }

const EDIT_TOOLS = ['EditFileTool', 'WriteFileTool', 'MultiEditTool'];
export const GIT_AUTOCOMMIT_TOOLS = EDIT_TOOLS;

function editedPath(args: any): string {
  if (args?.path) return args.path;
  if (Array.isArray(args?.edits) && args.edits[0]?.path) return args.edits[0].path;
  return 'changes';
}

/** PostToolUse handler: commit the just-made edit when auto-commit is enabled. */
export async function gitAutoCommitHook(toolName: string, args: any, result: any, context: any): Promise<void> {
  if (!enabled) return;
  // Skip when the edit didn't actually apply (rejected/cancelled/error result strings).
  if (typeof result === 'string' && /\b(rejected|cancelled|Error|blocked)\b/i.test(result)) return;

  const cwd = context?.cwd || process.cwd();
  if (!isGitRepo(cwd)) return; // not a git repo

  try {
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-m', `bimax auto: ${toolName} ${editedPath(args)}`], { cwd, stdio: 'ignore' });
    Logger.info(`[GitAutoCommit] committed after ${toolName}`);
  } catch {
    // Nothing staged / empty diff / hook conflict — non-fatal.
  }
}
