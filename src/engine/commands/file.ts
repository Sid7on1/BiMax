import { globalCommandRegistry } from './registry';
import { editFileLines, writeWithBackup, undoLast, getBackups, previewDiff } from '../fileEditor';

globalCommandRegistry.register({
  name: '/edit',
  description: 'Search & replace',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    if (args.length === 0) {
      return {
        type: 'prompt',
        title: 'Edit - Enter File Path',
        onResolve: (file: string) => {
          if (!file.trim()) return;
          context.setActivePrompt({
            title: 'Edit - Search String',
            onResolve: (search: string) => {
              if (!search) return;
              context.setActivePrompt({
                title: 'Edit - Replacement String',
                onResolve: (replace: string) => {
                  if (!replace) return;
                  // Use command redirect
                  context.setActivePrompt(null);
                  context.addSystemMessage('info', 'Running /edit...');
                  // Simulate redirect since this happens asynchronously
                  globalCommandRegistry.execute(`/edit ${file.trim()} "${search}" "${replace}"`, context)
                    .then(res => {
                      if (res.type === 'message') context.addSystemMessage(res.level, res.content);
                    });
                }
              });
            }
          });
        }
      };
    }

    if (args.length < 3 || !args[0].includes('.')) {
      return { type: 'message', level: 'info', content: 'Usage: /edit <file> "<search>" "<replace>"' };
    }

    const file = args[0];
    // The registry tokenizes on whitespace, so multi-word quoted strings arrive split
    // across several args (with their quote chars preserved). Rejoin and pull out the
    // two quoted segments so `"hello world"` survives intact.
    const rest = args.slice(1).join(' ');
    const quoted = rest.match(/"([^"]*)"/g);
    let search: string;
    let replace: string;
    if (quoted && quoted.length >= 2) {
      search = quoted[0].slice(1, -1);
      replace = quoted[1].slice(1, -1);
    } else {
      // Fallback for unquoted single-token search/replace
      search = args.slice(1, -1).join(' ').replace(/^"|"$/g, '');
      replace = args[args.length - 1].replace(/^"|"$/g, '');
    }

    const ok = await editFileLines(file, search, replace);
    return { type: 'message', level: ok ? 'success' : 'error', content: ok ? `Edited ${file}` : `No match found in ${file}` };
  }
});

globalCommandRegistry.register({
  name: '/write',
  description: 'Write file to disk',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    if (args.length === 0) {
      return {
        type: 'prompt',
        title: 'Write - Enter File Path',
        onResolve: (file: string) => {
          if (!file.trim()) return;
          context.setActivePrompt({
            title: 'Write - Enter File Content',
            onResolve: (content: string) => {
              if (!content) return;
              context.setActivePrompt(null);
              globalCommandRegistry.execute(`/write ${file.trim()} ${content}`, context)
                .then(res => {
                  if (res.type === 'message') context.addSystemMessage(res.level, res.content);
                });
            }
          });
        }
      };
    }

    if (args.length < 2) {
      return { type: 'message', level: 'info', content: 'Usage: /write <file> <content>' };
    }

    const wrFile = args[0];
    const wrContent = args.slice(1).join(' ');
    const bp = await writeWithBackup(wrFile, wrContent);
    return { type: 'message', level: 'success', content: `Wrote ${wrFile}${bp ? ' (backup saved)' : ' (new file)'}` };
  }
});

globalCommandRegistry.register({
  name: '/undo',
  description: 'Undo last edit',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    if (args.length === 0) {
      const list = await getBackups();
      if (list.length === 0) {
        return { type: 'message', level: 'info', content: 'No backups found to undo' };
      }
      return {
        type: 'menu',
        title: 'Select a Backup to Restore',
        options: list.map(b => ({
          label: b.file.split('_').pop() || b.file,
          value: b.file,
          desc: 'Restore this backup'
        })),
        onSelect: (opt: any) => context.executeCommand(`/undo ${opt.value}`),
      };
    }

    const ok = await undoLast(args[0]);
    return { type: 'message', level: ok ? 'success' : 'error', content: ok ? `Undid last edit to ${args[0]}` : 'No backup found' };
  }
});

globalCommandRegistry.register({
  name: '/diff-file',
  description: 'Show file diff',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    if (args.length === 0) {
      const list = await getBackups();
      if (list.length === 0) {
        return { type: 'message', level: 'info', content: 'No backups found to diff' };
      }
      return {
        type: 'menu',
        title: 'Select a Backup to Diff',
        options: list.map(b => ({
          label: b.file.split('_').pop() || b.file,
          value: b.file,
          desc: 'Diff against current file'
        })),
        onSelect: (opt: any) => context.executeCommand(`/diff-file ${opt.value}`),
      };
    }

    const diffStr = await previewDiff(args[0]);
    if (!diffStr) {
      return { type: 'message', level: 'info', content: `No diff available for ${args[0]}` };
    } else {
      return { type: 'message', level: 'info', content: diffStr };
    }
  }
});

globalCommandRegistry.register({
  name: '/backups',
  description: 'List backups',
  category: 'Source Control',
  execute: async (args, context) => {
    const list = await getBackups(args[0]);
    if (list.length === 0) {
      return { type: 'message', level: 'info', content: 'No backups found' };
    }
    return {
      type: 'menu',
      title: `Select Backup for ${args[0] || 'Any File'}`,
      options: list.map(b => ({
        label: b.file.split('_').pop() || b.file,
        value: b.file,
        description: b.file
      })),
      // Selecting a backup shows its diff against the live file (the natural next step).
      onSelect: (opt: any) => context.executeCommand(`/diff-file ${opt.value}`),
    };
  }
});
