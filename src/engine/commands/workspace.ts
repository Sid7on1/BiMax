import { globalCommandRegistry } from './registry';
import { tryGetWorkspace, RepoScope } from '../../core/workspace.manager';

// /workspace — the multi-repo working set (workspace.manager.ts, PR2 of
// docs/UPGRADE_2026_RESEARCH.md). Mirrors WorkspaceTool for direct user control.

globalCommandRegistry.register({
  name: '/workspace',
  aliases: ['/ws', '/repos'],
  description: 'Multi-repo workspace: list/register/scope the repos this session can see and edit',
  category: 'Session & Context',
  execute: async (args) => {
    const ws = tryGetWorkspace();
    if (!ws) return { type: 'message', level: 'error', content: 'Workspace not initialized yet — try again once the session finishes starting.' };

    // /workspace add <path> [:: purpose]   (registers read-only; use scope to unlock)
    if (args[0] === 'add' || args[0] === 'register') {
      const rest = args.slice(1).join(' ');
      const sep = rest.indexOf('::');
      const p = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
      const purpose = sep >= 0 ? rest.slice(sep + 2).trim() : undefined;
      if (!p) return { type: 'message', level: 'error', content: 'Usage: /workspace add <path> [:: purpose]' };
      const r = ws.register(p, { purpose });
      return { type: 'message', level: 'success', content: `Registered ${r.name} (read-only) at ${r.path}${r.branch ? ` [${r.branch}]` : ''}. Unlock edits with /workspace scope ${r.name} write.` };
    }

    // /workspace scope <name|path> <write|read>
    if (args[0] === 'scope') {
      const [, target, scope] = args;
      if (!target || !['write', 'read'].includes(scope)) return { type: 'message', level: 'error', content: 'Usage: /workspace scope <name|path> <write|read>' };
      const byName = ws.active().find(r => r.name === target);
      const r = ws.setScope(byName ? byName.path : target, scope as RepoScope);
      if (!r) return { type: 'message', level: 'error', content: `No registered repo "${target}". /workspace to list.` };
      return { type: 'message', level: 'success', content: `${r.name} is now ${r.scope === 'write' ? 'WRITABLE' : 'read-only'}.` };
    }

    // /workspace remove <name|path>  (marks ignored — never auto-suggested again)
    if (args[0] === 'remove' || args[0] === 'ignore') {
      const target = args[1];
      if (!target) return { type: 'message', level: 'error', content: 'Usage: /workspace remove <name|path>' };
      const byName = ws.active().find(r => r.name === target);
      ws.ignore(byName ? byName.path : target);
      return { type: 'message', level: 'success', content: `Removed ${target} from the workspace.` };
    }

    // /workspace scan [dir]
    if (args[0] === 'scan') {
      const found = ws.scan(args[1] || process.cwd());
      return {
        type: 'message', level: 'info',
        content: found.length
          ? `Unregistered clones:\n${found.map(f => `  ${f}`).join('\n')}\nRegister with /workspace add <path>.`
          : 'No unregistered clones found.',
      };
    }

    // default: list
    const act = ws.active();
    const pending = ws.pending();
    if (act.length <= 1 && pending.length === 0) {
      return { type: 'message', level: 'info', content: 'Single-repo session. Register another repo with /workspace add <path> — or just `git clone` one; BiMax will notice and ask.' };
    }
    const lines = act.map(r =>
      `  ${r.scope === 'write' ? '✎' : '◇'} ${r.name} (${r.scope})${r.branch ? ` [${r.branch}]` : ''} — ${r.path}${r.purpose ? `\n      ${r.purpose}` : ''}`);
    let content = `Workspace (${act.length} repos):\n${lines.join('\n')}`;
    if (pending.length) content += `\n\nDetected but unregistered:\n${pending.map(p => `  ${p}`).join('\n')}\nRegister with /workspace add <path>, dismiss with /workspace remove <path>.`;
    return { type: 'message', level: 'info', content };
  },
});
