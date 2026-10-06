import { globalCommandRegistry } from './registry';
import { globalTransactionManager } from '../../core/transaction.manager';
import { randomUUID } from 'crypto';

/**
 * /tx — Tracked multi-file edit transactions.
 *
 * /tx begin             — open a transaction (assigns an ID)
 * /tx commit            — finalize, keep all edits
 * /tx rollback          — undo every edit made since /tx begin
 * /tx rollback --force  — also overwrite files changed after the transaction wrote them
 * /tx recover           — retry paths a previous rollback could not restore
 * /tx status            — show whether a transaction is open, and anything pending recovery
 *
 * While a transaction is open, every mutating tool records the file's pre-edit state and declares
 * what it is about to write. If any edit fails, or if /tx rollback is called, every tracked path is
 * put back — EXCEPT one whose current content is neither the recorded original nor something this
 * transaction wrote. That is somebody else's later edit; it is kept, reported as a conflict, and
 * the pre-transaction bytes are retained under `.breakglass/transactions/<id>/` so nothing is lost.
 * `--force` overwrites those deliberately. A path whose original could not be read is reported as
 * unprotected rather than deleted.
 */
globalCommandRegistry.register({
  name: '/tx',
  description: 'Tracked multi-file edit transaction — begin / commit / rollback',
  category: 'Code & Intelligence',
  execute: async (args, _context) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'begin' || sub === 'start') {
      // Begin fails if one is already open — report that at error level, not success.
      if (globalTransactionManager.isOpen()) {
        return { type: 'message', level: 'error', content: `Transaction ${globalTransactionManager.currentId()} is already open. Commit or roll it back first (/tx commit · /tx rollback).` };
      }
      const id = `TX-${randomUUID().slice(0, 6).toUpperCase()}`;
      const msg = globalTransactionManager.begin(id);
      return { type: 'message', level: globalTransactionManager.currentId() === id ? 'success' : 'error', content: msg };
    }

    if (sub === 'commit' || sub === 'done') {
      const wasOpen = globalTransactionManager.isOpen();
      const msg = globalTransactionManager.commit();
      return { type: 'message', level: wasOpen && !globalTransactionManager.isOpen() ? 'success' : 'error', content: msg };
    }

    if (sub === 'rollback' || sub === 'abort' || sub === 'undo') {
      const force = args.slice(1).some(a => a.toLowerCase() === '--force' || a.toLowerCase() === 'force');
      const result = await globalTransactionManager.rollbackDetailed({ force });
      // A rollback that kept a conflicting file, hit a failure, or could not protect a path is not
      // a success message — the receipt has to carry the same weight the outcome does.
      const unresolved = result.entries.filter(e => e.status === 'conflict' || e.status === 'failed' || e.status === 'unprotected');
      return { type: 'message', level: !result.id || unresolved.length ? 'error' : 'info', content: result.message };
    }

    if (sub === 'recover') {
      const blocked = globalTransactionManager.status().phase !== 'idle';
      const msg = await globalTransactionManager.recover();
      return { type: 'message', level: blocked || globalTransactionManager.pendingRecovery() ? 'error' : 'info', content: msg };
    }

    if (sub === 'status') {
      const status = globalTransactionManager.status();
      const pending = globalTransactionManager.pendingRecoveries();
      const pendingNote = pending.map(pending =>
          `\nTransaction ${pending.id} has ${pending.paths.length} path(s) still pending: ${pending.paths.join(', ')}.` +
          (pending.dir ? ` Pre-transaction content is retained in ${pending.dir}.` : ' Their content is held in memory only.') +
          ' Use /tx recover to retry; newer content and permissions are kept.'
      ).join('');
      const budgetNote = `\nSnapshot memory: ${status.heldSnapshotBytes} / ${status.maxTotalSnapshotBytes} bytes held or reserved, including recovery baselines.`;
      if (status.phase === 'restoring') {
        return { type: 'message', level: 'info', content: `Restoration is in progress. Wait before beginning a transaction or retrying recovery.${budgetNote}${pendingNote}` };
      }
      if (globalTransactionManager.isOpen()) {
        const coverage = `\n${status.paths} path(s) captured: ${status.protectedPaths} protected, ${status.unprotectedPaths} unprotected; ${status.pendingSnapshots} snapshot operation(s) pending.`;
        return { type: 'message', level: status.unprotectedPaths ? 'error' : 'info', content: `Transaction ${globalTransactionManager.currentId()} is OPEN. Use /tx commit or /tx rollback.${coverage}${budgetNote}${pendingNote}` };
      }
      return { type: 'message', level: pending.length ? 'error' : 'info', content: `No open transaction. Use /tx begin to start one.${budgetNote}${pendingNote}` };
    }

    return {
      type: 'message',
      level: 'info',
      content: [
        '/tx begin    — open a transaction (tracks edits and reports snapshot coverage)',
        '/tx commit   — finalize and keep all edits',
        '/tx rollback — undo every edit made in this transaction (files changed since are kept)',
        '/tx rollback --force — also overwrite files changed after this transaction wrote them',
        '/tx recover  — retry paths a previous rollback could not restore',
        '/tx status   — inspect protected paths, snapshot memory and pending recovery',
      ].join('\n'),
    };
  },
});
