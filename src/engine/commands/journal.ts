import { globalCommandRegistry } from './registry';
import { dateKeyOf, journalDigest, renderDayMarkdown, writeDayArtifact } from '../../mind/daily.journal';

/**
 * /journal — the plain-markdown daily diary (PR4, pi-mem). Projected from the event ledger: shows
 * today by default, `/journal yesterday`, or `/journal YYYY-MM-DD`. `/journal write [date]` renders
 * the day to .bimax/journal/<date>.md for the human to read or edit.
 */
globalCommandRegistry.register({
  name: '/journal',
  description: 'Daily work diary (projected from the ledger). `/journal [yesterday|YYYY-MM-DD]`, or `/journal write [date]`.',
  category: 'Code & Intelligence',
  execute: async (args) => {
    const a0 = (args[0] || '').toLowerCase();

    const resolveKey = (tok: string): string => {
      if (!tok || tok === 'today') return dateKeyOf(Date.now());
      if (tok === 'yesterday') return dateKeyOf(Date.now() - 86_400_000);
      return tok; // assume YYYY-MM-DD
    };

    if (a0 === 'write') {
      const key = resolveKey((args[1] || '').toLowerCase());
      const file = writeDayArtifact(key);
      return file
        ? { type: 'message', level: 'success', content: `Wrote journal for ${key} → ${file}` }
        : { type: 'message', level: 'error', content: `Could not write the journal for ${key}.` };
    }

    const key = resolveKey(a0);
    return { type: 'message', level: 'info', content: renderDayMarkdown(journalDigest(key)) };
  },
});
