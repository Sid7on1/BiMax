import * as path from 'path';
import { globalCommandRegistry } from './registry';
import { readIdeSelection } from '../ideSelection';

/**
 * /selection — show the IDE selection BiMax currently sees from your editor, and how to wire it.
 *
 * The bridge is dependency-free and editor-agnostic: an editor/extension/keybinding writes the
 * range the user has selected to a small JSON handoff, and BiMax reads it. Once configured,
 * typing `@selection` (or `@sel`) in a prompt injects that exact range, range-precise.
 */
globalCommandRegistry.register({
  name: '/selection',
  aliases: ['/sel'],
  description: 'Show the current IDE selection BiMax sees (used by @selection)',
  category: 'Code & Intelligence',
  execute: async (_args, context) => {
    const cwd = context.cwd || process.cwd();
    const sel = readIdeSelection(cwd);

    if (!sel) {
      return {
        type: 'message',
        level: 'info',
        content:
          'No IDE selection detected. Wire your editor to BiMax by writing the selected range to one of:\n' +
          '  • <project>/.bimax/ide-selection.json   {"file":"src/x.ts","startLine":10,"endLine":24}\n' +
          '  • $BIMAX_IDE_SELECTION                   inline JSON, or a path to a JSON file\n' +
          '  • $BIMAX_IDE_FILE (+ $BIMAX_IDE_START_LINE / $BIMAX_IDE_END_LINE)\n' +
          'Then type @selection (or @sel) in a prompt to inject that exact range.',
      };
    }

    const rel = path.relative(cwd, sel.file) || path.basename(sel.file);
    const preview = sel.text.split('\n').slice(0, 12).join('\n');
    const more = sel.text.split('\n').length > 12 ? `\n…(${sel.text.split('\n').length - 12} more lines)` : '';
    return {
      type: 'message',
      level: 'success',
      content:
        `Current selection (via ${sel.source}):\n` +
        `  ${rel}:${sel.startLine}-${sel.endLine}\n\n` +
        `${preview}${more}\n\n` +
        'Type @selection in a prompt to inject this range.',
    };
  },
});
