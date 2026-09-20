import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * WP-0 (docs/product-reset/57): the word "thread" means the product feature, and nothing else.
 *
 * Three things in this repository have been called a thread — the Bimax Thread (a folder-bound
 * conversation with its own engine process), the sub-agent worker (a real `worker_threads` Worker),
 * and a CPU core. Two of those carry resource caps that both happen to be `4`, and they were never
 * reconciled precisely BECAUSE the shared word hid that they govern different resources: one is a
 * memory budget over engine processes, the other a CPU budget over workers. That cost us WP-1,
 * where the per-machine worker ceiling was being handed to each Bimax Thread and so multiplied by
 * the number of live Threads. The glossary is in AGENTS.md; this is what keeps it true.
 *
 * `worker thread` is deliberately ALLOWED. It is the precise name for a `worker_threads` Worker,
 * the noun is qualified, and no reader could take it for the product feature. What is banned is the
 * unqualified CPU sense — a "thread pool", a "cpu thread", "concurrent threads" — because that is
 * the phrasing that reads as the product feature to anyone who knows the product.
 */

const ROOTS = ['app/src', 'src'];

/** The CPU sense of "thread", unqualified. Say "worker" or "core" instead. */
const BANNED = [
  'thread[- ]pool',
  '(cpu|core|hardware|hyper)[- ]?threads?\\b',
  'concurrent threads?\\b',
  'parallel threads?\\b',
  'threads? per (core|cpu)',
].join('|');

test('the CPU sense of "thread" does not appear in source — say worker, or core', () => {
  const repo = path.resolve(__dirname, '..', '..', '..');
  let hits = '';
  try {
    // `-a` is load-bearing, not tidiness: grep SKIPS a file it believes is binary, and five source
    // files in this repo were binary-looking because of a raw NUL or ESC inside a string literal
    // (see src/__tests__/source.greppable.test.ts). Without it this gate silently covered less than
    // it claimed — the exact failure it exists to prevent. That test now bans the bytes; this flag
    // means the gate keeps working even if one comes back.
    // grep exits 1 with no matches, which is the passing case.
    hits = execFileSync('grep', ['-rniEa', BANNED, '--include=*.ts', '--include=*.tsx', ...ROOTS], {
      cwd: repo, encoding: 'utf8',
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
  }

  const offenders = hits.split('\n')
    .filter(Boolean)
    // This file names the banned forms in order to ban them.
    .filter((line) => !line.startsWith('app/src/__tests__/naming.thread.test.ts:'));

  expect(offenders).toEqual([]);
});
