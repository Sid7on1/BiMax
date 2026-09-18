import { execFileSync } from 'child_process';
import { globalCommandRegistry } from './registry';
import { getGitStatus, gitDiff, gitLog } from '../git';
import { setGitAutoCommitEnabled, isGitAutoCommitEnabled } from '../../tools/git.autocommit';

globalCommandRegistry.register({
  name: '/git',
  description: 'Git status · /git commit <msg> · /git checkout <branch>',
  category: 'Source Control',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();

    // Writes route through here (not raw git in the UI shells) so the ledger and attribution
    // pipeline observe them like any other engine action.
    if (sub === 'commit') {
      const message = args.slice(1).join(' ').trim();
      if (!message) return { type: 'message', level: 'error', content: 'Usage: /git commit <message>' };
      try {
        execFileSync('git', ['add', '-A'], { cwd: context.cwd, stdio: 'pipe' });
        const out = execFileSync('git', ['commit', '-m', message], { cwd: context.cwd, encoding: 'utf-8', stdio: 'pipe' });
        return { type: 'message', level: 'success', content: out.trim().split('\n')[0] || `Committed: ${message}` };
      } catch (err: any) {
        const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
        return { type: 'message', level: 'error', content: `Commit failed: ${detail.slice(0, 400)}` };
      }
    }

    if (sub === 'checkout' || sub === 'switch') {
      const name = (args[1] || '').trim();
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /git checkout <branch>' };
      try {
        try {
          execFileSync('git', ['checkout', name], { cwd: context.cwd, stdio: 'pipe' });
          return { type: 'message', level: 'success', content: `Switched to branch ${name}` };
        } catch {
          execFileSync('git', ['checkout', '-b', name], { cwd: context.cwd, stdio: 'pipe' });
          return { type: 'message', level: 'success', content: `Created and switched to new branch ${name}` };
        }
      } catch (err: any) {
        const detail = String(err?.stderr || err?.message || err).trim();
        return { type: 'message', level: 'error', content: `Checkout failed: ${detail.slice(0, 400)}` };
      }
    }

    const status = getGitStatus(context.cwd);
    if (!status) return { type: 'message', level: 'info', content: 'Not a git repository' };
    
    return {
      type: 'message',
      level: 'info',
      content: ` ${status.branch} · +${status.added.length} ~${status.modified.length} -${status.deleted.length} ?${status.unstaged.length} ${status.ahead > 0 ? `↑${status.ahead}` : ''}${status.behind > 0 ? `↓${status.behind}` : ''}`
    };
  }
});

globalCommandRegistry.register({
  name: '/diff',
  description: 'Git diff',
  category: 'Source Control',
  execute: async (args, context) => {
    const file = args[0];
    if (!file) {
      return {
        type: 'prompt',
        title: 'Diff - Enter File Path (or leave empty for all)',
        onResolve: (fileStr: string) => {
          context.addSystemMessage('info', 'Running /diff...');
          // Using redirect to re-trigger the command once resolved
          return `/diff ${fileStr.trim() || '.'}`;
        }
      };
    }
    
    const diff = gitDiff(context.cwd, file === '.' ? undefined : file);
    return {
      type: 'message',
      level: 'info',
      content: diff ? `Diff${file ? ` (${file})` : ''}:\n${diff.slice(0, 1000)}` : 'No changes'
    };
  }
});

globalCommandRegistry.register({
  name: '/log',
  description: 'Git log',
  category: 'Source Control',
  execute: async (args, context) => {
    const log = gitLog(context.cwd, 10);
    return { type: 'message', level: 'info', content: log };
  }
});

globalCommandRegistry.register({
  name: '/autocommit',
  description: 'Auto-commit each agent edit',
  category: 'Source Control',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      const on = sub === 'on';
      setGitAutoCommitEnabled(on);
      await context.saveConfig({ gitAutoCommit: on });
      return { type: 'message', level: 'success', content: `Git auto-commit is ${on ? 'ON — each successful edit is committed automatically' : 'OFF'}.` };
    }
    return {
      type: 'menu',
      title: `Git auto-commit (currently ${isGitAutoCommitEnabled() ? 'ON' : 'OFF'})`,
      options: [
        { label: '[ ON ]', value: '/autocommit on', desc: 'Commit after every agent edit (Aider-style)' },
        { label: '[ OFF ]', value: '/autocommit off', desc: 'Commit only when you ask' },
      ],
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  }
});
