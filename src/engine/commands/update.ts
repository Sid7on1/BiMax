import { globalCommandRegistry } from './registry';
import { updateChecker } from '../../core/self.update';

/**
 * /update — Phase 3b. Check whether a newer Bimax is published and show any pending announcements.
 *
 * /update        — force a fresh check; print current vs latest + upgrade command + announcements
 * /update seen   — mark all currently-shown announcements as read (stop re-showing them)
 *
 * This command never installs anything. It only reports the upgrade command for you to run.
 */
globalCommandRegistry.register({
  name: '/update',
  aliases: ['/upgrade'],
  description: 'Check for a newer Bimax version and view announcements (never auto-installs)',
  category: 'Configuration',
  execute: async (args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'seen') {
      // Re-read (cached) and mark whatever is currently pending as seen.
      const report = await updateChecker.check(false);
      updateChecker.markSeen(report.announcements.map((a) => a.id));
      return { type: 'message', level: 'success', content: `Marked ${report.announcements.length} announcement(s) as read.` };
    }

    const report = await updateChecker.check(true);
    const lines: string[] = [];

    if (report.updateAvailable && report.latest) {
      lines.push(`⬆️  Update available: ${report.current} → ${report.latest}`);
      lines.push(`   Upgrade with:  ${report.downloadCmd}`);
    } else if (report.latest) {
      lines.push(`✅ Bimax is up to date (${report.current}).`);
    } else {
      lines.push(`Bimax ${report.current} — could not reach the update source (offline or disabled).`);
    }

    if (report.announcements.length) {
      lines.push('');
      lines.push('📣 Announcements:');
      for (const a of report.announcements) {
        lines.push(`   ${a.level === 'warn' ? '⚠️ ' : '• '}${a.text}`);
      }
      lines.push('');
      lines.push('   Run /update seen to dismiss these.');
    }

    return { type: 'message', level: report.updateAvailable ? 'info' : 'success', content: lines.join('\n') };
  },
});
