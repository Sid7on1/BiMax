import { globalCommandRegistry } from './registry';
import { globalCheckpointManager, Checkpoint } from '../../sandbox/checkpoint.manager';
import { engineEvents } from '../events';

function rel(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function describe(c: Checkpoint): string {
  return `${c.id}  ${c.auto ? '·' : '★'} ${c.label} (${rel(c.timestamp)})`;
}

globalCommandRegistry.register({
  name: '/checkpoint',
  aliases: ['/cp'],
  description: 'Snapshot the working tree (Time Machine)',
  category: 'Session & Context',
  execute: async (args) => {
    if (!globalCheckpointManager.isGitRepo()) {
      return { type: 'message', level: 'error', content: 'Checkpoints need a git repository. Run `git init` first.' };
    }
    if (args[0] === 'list') {
      const list = globalCheckpointManager.list();
      if (list.length === 0) return { type: 'message', level: 'info', content: 'No checkpoints yet. Run /checkpoint to make one.' };
      return { type: 'message', level: 'info', content: `Checkpoints (★ manual · auto):\n${list.map(describe).join('\n')}` };
    }
    const label = args.join(' ').trim() || 'manual checkpoint';
    const cp = globalCheckpointManager.create(label, false);
    if (!cp) {
      engineEvents.emit('checkpoint_failed', label); // review domain records the failed attempt
      return { type: 'message', level: 'error', content: 'Failed to create checkpoint.' };
    }
    engineEvents.emit('timemachine_changed'); // ui_snapshot.checkpoints → front-end History strips
    return { type: 'message', level: 'success', content: `📸 Checkpoint ${cp.id} saved — "${cp.label}". Use /rewind to restore.` };
  }
});

globalCommandRegistry.register({
  name: '/rewind',
  description: 'Restore an earlier checkpoint (Time Machine)',
  category: 'Session & Context',
  execute: async (args, context) => {
    if (!globalCheckpointManager.isGitRepo()) {
      return { type: 'message', level: 'error', content: 'Rewind needs a git repository.' };
    }
    const list = globalCheckpointManager.list();
    if (list.length === 0) {
      return { type: 'message', level: 'info', content: 'No checkpoints to rewind to. Run /checkpoint first.' };
    }

    if (!args[0]) {
      return {
        type: 'menu',
        title: 'Rewind working tree to checkpoint',
        options: list.slice(0, 25).map(c => ({
          label: describe(c),
          value: c.id,
          desc: c.auto ? 'auto-snapshot' : 'manual checkpoint'
        })),
        onSelect: (opt: any) => context.executeCommand(`/rewind ${opt.value}`)
      };
    }

    const id = args[0].replace(/^rewind:/, '');
    const result = globalCheckpointManager.restore(id);
    if (!result) {
      return { type: 'message', level: 'error', content: `Checkpoint "${id}" not found. Use /checkpoint list.` };
    }
    engineEvents.emit('timemachine_changed');
    const safetyNote = result.safety ? ` A safety checkpoint (${result.safety.id}) of your previous state was saved — /rewind it to undo this.` : '';
    return {
      type: 'message',
      level: 'success',
      content: `⏪ Rewound working tree to ${result.restored.id} — "${result.restored.label}".${safetyNote}`
    };
  }
});
