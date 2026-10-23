import { globalCommandRegistry } from './registry';
import { ScoutAgent, formatScoutReport } from '../../agents/scout.agent';

/**
 * /scout <git-url> — shallow-clone a remote repo, extract structure, and report back.
 * Read-only: nothing is written to the user's working directory.
 */
globalCommandRegistry.register({
  name: '/scout',
  description: 'Inspect a remote git repo (structure, languages, exports) without cloning into your project',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const url = args.join(' ').trim();
    if (!url) {
      return {
        type: 'message',
        level: 'info',
        content: 'Usage: /scout <git-url>\nExample: /scout https://github.com/owner/repo',
      };
    }

    // Basic validation — must look like a URL or a git remote
    if (!url.includes('/') && !url.startsWith('git@')) {
      return { type: 'message', level: 'error', content: `"${url}" does not look like a valid git URL.` };
    }

    context.addSystemMessage('info', `Scouting ${url} — this may take up to 60s for a shallow clone…`);

    const agent = new ScoutAgent();
    try {
      const report = await agent.inspect(url);
      return { type: 'message', level: report.error ? 'error' : 'success', content: formatScoutReport(report) };
    } catch (e: any) {
      return { type: 'message', level: 'error', content: `Scout error: ${e.message}` };
    }
  },
});
