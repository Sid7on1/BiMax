import { stateDir } from '../../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { globalCommandRegistry } from './registry';
import { SessionStore } from '../session';

/**
 * /replay — export the current session transcript as a shareable markdown report.
 */
globalCommandRegistry.register({
  name: '/replay',
  aliases: ['/export'],
  description: 'Export this session as a markdown report',
  category: 'Session & Context',
  execute: async (_args, context) => {
    const store = new SessionStore();
    const messages = await store.loadAll();
    if (messages.length === 0) {
      return { type: 'message', level: 'info', content: 'No session transcript to export yet.' };
    }

    const lines: string[] = [
      `# BiMax Session Replay`,
      ``,
      `- Exported: ${new Date().toISOString()}`,
      `- Workspace: ${context.cwd}`,
      `- Messages: ${messages.length}`,
      ``,
      `---`,
      ``,
    ];
    for (const m of messages) {
      const who = m.role === 'user' ? '🧑 User' : m.role === 'assistant' ? '🤖 BiMax' : 'ℹ️ System';
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      lines.push(`### ${who}${ts ? ` · ${ts}` : ''}`, ``, text || '_(empty)_', ``);
    }

    const outDir = path.join(stateDir('.breakglass', context.cwd), 'replays');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `replay-${stamp}.md`);
    try {
      fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Failed to write replay: ${e.message}` };
    }
    return { type: 'message', level: 'success', content: `📝 Session exported (${messages.length} messages) to ${path.relative(context.cwd, outPath)}` };
  }
});
