import { execFileSync } from 'child_process';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { getGitStatus, gitDiff, gitLog, isGitRepo } from '../../engine/git';

// B1 — agent-callable git. Read actions (status/diff/log) run freely; mutating actions
// (add/commit) are routed through the Governor's OS_COMMAND path (reusing its veto / plan-mode
// blocking / interactive prompt) and use execFileSync arg-arrays so commit messages can't
// inject shell. Intentionally does NOT push — outward-facing actions stay manual.

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
}

export const createGitTool = (governor: IGovernor) => buildTool({
  name: 'GitTool',
  description: `Run local git operations on the workspace.

# Actions (pass as \`action\`)
- \`status\` — branch + staged/modified/untracked counts.
- \`diff\` — unstaged diff (optionally limited to \`paths\`).
- \`log\` — recent commits.
- \`add\` — stage \`paths\` (default: everything).
- \`commit\` — stage + commit with your \`message\`. Stages ONLY \`paths\` when given; with no \`paths\` it stages EVERYTHING, including untracked files — pass \`paths\` whenever the working tree may hold unrelated changes, so they don't ride along. Compose a concise, conventional message describing the change.

Does NOT push. Use commit to checkpoint a logical unit of work.`,
  isDestructive: false, // per-action governance handled inside
  /**
   * Per-call: the reporting actions read the repo and may overlap with sibling calls, while `add`
   * and `commit` mutate the index and must hold the turn's barrier. Unknown or missing actions
   * fail closed to exclusive.
   */
  isConcurrencySafe: (args: any) => ['status', 'diff', 'log'].includes(args?.action),
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'diff', 'log', 'add', 'commit'], description: 'The git operation.' },
      message: { type: 'string', description: 'Commit message (required when action is "commit").' },
      paths: { type: 'string', description: 'Optional space-separated paths for add/diff/commit (default: all).' },
    },
    required: ['action'],
  },
  execute: async (args: { action: string; message?: string; paths?: string }, context?: any) => {
    const cwd = context?.cwd || process.cwd();
    if (!isGitRepo(cwd)) return 'Error: not a git repository (run `git init` first).';

    switch (args.action) {
      case 'status': {
        const s = getGitStatus(cwd);
        if (!s) return 'Repository has no commits yet (unborn HEAD). Stage and commit to create the first commit.';
        return `On ${s.branch} · staged +${s.added.length} modified ~${s.modified.length} deleted -${s.deleted.length} untracked ?${s.unstaged.length}`;
      }
      case 'log':
        return gitLog(cwd, 15) || 'No commits yet.';
      case 'diff':
        return gitDiff(cwd, args.paths?.trim() || undefined) || 'No changes.';
      case 'add': {
        const paths = args.paths?.trim() ? args.paths.trim().split(/\s+/) : ['-A'];
        await governor.approveTaskExecution('OS_COMMAND', { command: `git add ${paths.join(' ')}`, isDestructive: true });
        git(['add', ...paths], cwd);
        return `Staged: ${paths.join(' ')}`;
      }
      case 'commit': {
        if (!args.message?.trim()) return 'Error: commit requires a non-empty `message`.';
        // Honor `paths` exactly like `add` does: a scoped commit must not sweep up unrelated
        // working-tree changes (the description promises this — keep them in lockstep).
        const commitPaths = args.paths?.trim() ? args.paths.trim().split(/\s+/) : ['-A'];
        await governor.approveTaskExecution('OS_COMMAND', { command: `git add ${commitPaths.join(' ')} && git commit`, isDestructive: true });
        git(['add', ...commitPaths], cwd);
        try {
          const out = git(['commit', '-m', args.message.trim()], cwd);
          return out.trim() || 'Committed.';
        } catch (e: any) {
          return `Commit failed: ${(e.stdout || e.stderr || e.message).toString().trim()}`;
        }
      }
      default:
        return `Unknown action: ${args.action}. Use status|diff|log|add|commit.`;
    }
  },
}, governor);
