import path from 'node:path';
import { spendLedgerEnvironment } from '../main/thread.manager';
import { threadStateEnvironment } from '../main/thread.undo';
import {
  SPEND_LEDGER_ENV, SPEND_SCOPE_ENV, resolveSpendContext,
} from '../../../src/governor/spend.ledger';

/**
 * F5 (docs/product-reset/48): one money ledger for the Mac, and a share per Bimax Thread.
 *
 * The defect: the engine's daily spend total lives under `stateDir('.breakglass')`, `stateDir`
 * follows `BIMAX_STATE_DIR`, and `threadStateEnvironment` sets that to a per-FOLDER directory for
 * every ⌘2 Thread. So each Thread got its own spend file and its own full $5/day. Four such files
 * were found on the development machine before this fix.
 *
 * Asserted as PROPERTIES, never as a dollar figure — the cap is the user's to set.
 */

const USER_DATA = path.join(path.sep, 'Users', 'x', 'Library', 'Application Support', 'Bimax');

describe('the ledger is one file for the Mac', () => {
  test('two Bimax Threads in different folders share it', () => {
    const a = spendLedgerEnvironment(USER_DATA, 'thread-a');
    const b = spendLedgerEnvironment(USER_DATA, 'thread-b');
    expect(a[SPEND_LEDGER_ENV]).toBe(b[SPEND_LEDGER_ENV]);
  });

  test('it lives under userData, not inside any Thread folder — which is the bug', () => {
    // threadStateEnvironment is what redirected it per-folder. The two must NOT agree: the spend
    // ledger has to sit outside the per-Thread state root, or the fix is undone by the redirect.
    const state = threadStateEnvironment(USER_DATA, path.join(path.sep, 'tmp', 'project-a'), 'quick');
    const ledger = spendLedgerEnvironment(USER_DATA, 'thread-a')[SPEND_LEDGER_ENV];

    expect(ledger.startsWith(USER_DATA + path.sep)).toBe(true);
    expect(ledger.startsWith(state.BIMAX_STATE_DIR + path.sep)).toBe(false);
  });

  test('the env names the desktop writes are the ones the engine reads', () => {
    const env = spendLedgerEnvironment(USER_DATA, 'thread-a', 2);
    // The desktop build must not compile the engine, so the names are literals at the spawn site.
    // resolveSpendContext is the engine's own reader; this is what stops the two drifting.
    expect(resolveSpendContext(env)).toEqual({ path: env[SPEND_LEDGER_ENV], scope: 'thread-a' });
  });
});

describe('the per-Thread share', () => {
  test('each Thread is scoped by its own id, so spend is attributable', () => {
    expect(spendLedgerEnvironment(USER_DATA, 'thread-a')[SPEND_SCOPE_ENV]).toBe('thread-a');
    expect(spendLedgerEnvironment(USER_DATA, 'thread-b')[SPEND_SCOPE_ENV]).toBe('thread-b');
  });

  test('scoping by THREAD id, not folder, so a re-run does not inherit yesterday', () => {
    const first = spendLedgerEnvironment(USER_DATA, 'thread-monday');
    const second = spendLedgerEnvironment(USER_DATA, 'thread-tuesday');
    expect(first[SPEND_SCOPE_ENV]).not.toBe(second[SPEND_SCOPE_ENV]);
  });

  test('no cap configured → no per-Thread ceiling, only the machine one', () => {
    // The failure direction matters: inventing a share the user never asked for would start
    // refusing work mid-task on a machine that was previously fine.
    const env = spendLedgerEnvironment(USER_DATA, 'thread-a');
    expect(env.BIMAX_SPEND_SCOPE_CAP).toBeUndefined();
    expect(spendLedgerEnvironment(USER_DATA, 'thread-a', 0).BIMAX_SPEND_SCOPE_CAP).toBeUndefined();
  });

  test('a configured cap is passed through', () => {
    expect(spendLedgerEnvironment(USER_DATA, 'thread-a', 1.5).BIMAX_SPEND_SCOPE_CAP).toBe('1.5');
  });

  test('an engine with no thread id still shares the ledger, just unscoped', () => {
    const env = spendLedgerEnvironment(USER_DATA, undefined);
    expect(env[SPEND_LEDGER_ENV]).toBeTruthy();
    expect(env[SPEND_SCOPE_ENV]).toBeUndefined();
  });
});
