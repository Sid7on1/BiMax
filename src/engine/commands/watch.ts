import { globalCommandRegistry } from './registry';
import { globalWatcherManager, Watcher } from '../watchers';

function describe(w: Watcher): string {
  const state = w.enabled ? '●' : '○';
  return `${state} ${w.id} [${w.kind}] ${w.spec} → ${w.action} (fired ${w.fires}/${w.maxFires})`;
}

/**
 * /watch — wake the agent on a file change or a cron schedule to run an action.
 *   /watch file <path> <action…>     e.g. /watch file src /heal
 *   /watch cron "<expr>" <action…>   e.g. /watch cron "*\/30 * * * *" /heal
 *   /watch list | /watch remove <id> | /watch stop
 */
globalCommandRegistry.register({
  name: '/watch',
  description: 'Watch a file/schedule and wake the agent to act',
  category: 'General',
  execute: async (args) => {
    const sub = (args[0] || '').toLowerCase();

    if (!sub || sub === 'list') {
      const list = globalWatcherManager.list();
      if (list.length === 0) {
        return { type: 'message', level: 'info', content: 'No watchers. Add one:\n  /watch file <path> <action>\n  /watch cron "<expr>" <action>\nExample: /watch file src /heal' };
      }
      return { type: 'message', level: 'info', content: `Watchers (● active ○ off):\n${list.map(describe).join('\n')}` };
    }

    if (sub === 'remove' || sub === 'rm') {
      const id = args[1];
      if (!id) return { type: 'message', level: 'error', content: 'Usage: /watch remove <id>' };
      return globalWatcherManager.remove(id)
        ? { type: 'message', level: 'success', content: `Removed watcher ${id}.` }
        : { type: 'message', level: 'error', content: `No watcher ${id}.` };
    }

    if (sub === 'stop') {
      globalWatcherManager.stopAll();
      return { type: 'message', level: 'success', content: 'All watchers stopped.' };
    }

    if (sub === 'file' || sub === 'cron') {
      const spec = args[1];
      const action = args.slice(2).join(' ').trim();
      if (!spec || !action) {
        return { type: 'message', level: 'error', content: `Usage: /watch ${sub} ${sub === 'cron' ? '"<expr>"' : '<path>'} <action>` };
      }
      const res = globalWatcherManager.add(sub, spec, action);
      if ('error' in res) return { type: 'message', level: 'error', content: res.error };
      return { type: 'message', level: 'success', content: `👁️ Watching (${res.id}): ${res.kind} ${res.spec} → ${res.action}. Use /watch list or /watch remove ${res.id}.` };
    }

    return { type: 'message', level: 'error', content: 'Usage: /watch file|cron|list|remove|stop …' };
  }
});
