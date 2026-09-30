import { execFileSync } from 'child_process';
import { isGitRepo } from '../engine/git';
import { Logger } from '../utils/logger';

// B1 (opt-in) — auto-commit each successful edit, Aider-style. Off by default; toggled via
// `/git autocommit on|off` or Settings → Git auto-commit. Implemented as a PostToolUse hook (A2)
// registered by startHeadless (the app's engine), so sub-agent workers never auto-commit. A throwing commit is swallowed by
// the hook runner, so a non-repo / empty-diff never breaks the turn.

let enabled = false;
export function setGitAutoCommitEnabled(v: boolean): void { enabled = v; }
export function isGitAutoCommitEnabled(): boolean { return enabled; }

const EDIT_TOOLS = ['EditFileTool', 'WriteFileTool', 'MultiEditTool'];
export const GIT_AUTOCOMMIT_TOOLS = EDIT_TOOLS;

/** Every file the edit touched, as the tool was asked to write it. Empty when the arguments name none. */
function editedPaths(args: any): string[] {
  if (typeof args?.path === 'string' && args.path) return [args.path];
  if (Array.isArray(args?.edits)) {
    const paths: string[] = args.edits.map((edit: any) => edit?.path).filter((p: unknown): p is string => typeof p === 'string' && !!p);
    return [...new Set(paths)];
  }
  return [];
}

/** PostToolUse handler: commit the just-made edit when auto-commit is enabled. */
export async function gitAutoCommitHook(toolName: string, args: any, result: any, context: any): Promise<void> {
  if (!enabled) return;
  // Skip when the edit didn't actually apply (rejected/cancelled/error result strings).
  if (typeof result === 'string' && /\b(rejected|cancelled|Error|blocked)\b/i.test(result)) return;

  const cwd = context?.cwd || process.cwd();
  if (!isGitRepo(cwd)) return; // not a git repo

  // Only the files this edit wrote. This was `git add -A`, which swept the user's own uncommitted work —
  // anything they were halfway through — into a "bimax auto" commit. It never ran in the app (the hook
  // was not registered after the Ink terminal was retired), so it is narrowed before it ever does.
  const paths = editedPaths(args);
  if (paths.length === 0) return;
  try {
    execFileSync('git', ['add', '--', ...paths], { cwd });
    execFileSync('git', ['commit', '-m', `bimax auto: ${toolName} ${paths.join(', ')}`, '--', ...paths], { cwd, stdio: 'ignore' });
    Logger.info(`[GitAutoCommit] committed after ${toolName}`);
  } catch {
    // Nothing staged / empty diff / hook conflict — non-fatal.
  }
}
