import path from 'node:path';
import { workerCapacityEnvironment } from '../main/thread.manager';
import { CAPACITY_PATH_ENV, resolveCapacityContext } from '../../../src/core/subagent.capacity';

/**
 * WP-1 (docs/product-reset/57): one sub-agent WORKER budget for the machine, not one per Bimax
 * Thread.
 *
 * Sub-agent workers are real `worker_threads` OS threads and are capped per engine PROCESS, against
 * whichever lease ledger `resolveCapacityContext` resolves. That ledger is per-folder by default,
 * and Bimax Threads are folder-exclusive — so before this wiring every live Thread had a private
 * ledger and a private ceiling, and the per-machine number the adaptive policy computes was handed
 * to each of them instead of being shared between them.
 *
 * These tests assert the PROPERTY (all engines land on one ledger), never a worker count: the count
 * is the adaptive policy's to choose and is expected to move with the machine.
 */

const A = path.join(path.sep, 'tmp', 'project-a');
const B = path.join(path.sep, 'tmp', 'project-b');

describe('sub-agent worker capacity is machine-wide', () => {
  const saved = process.env[CAPACITY_PATH_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[CAPACITY_PATH_ENV];
    else process.env[CAPACITY_PATH_ENV] = saved;
  });

  test('the desktop hands every engine the same ledger, whatever folder the Thread is in', () => {
    const env = workerCapacityEnvironment('/Users/x/Library/Application Support/Bimax');
    process.env[CAPACITY_PATH_ENV] = env[CAPACITY_PATH_ENV];

    expect(resolveCapacityContext(A).path).toBe(resolveCapacityContext(B).path);
  });

  test('the env name the desktop writes is the one the engine reads', () => {
    // The desktop build must not compile the engine, so the name is a literal at the spawn site.
    // This is what stops that literal drifting away from the engine's own constant in silence.
    expect(Object.keys(workerCapacityEnvironment('/tmp/userData'))).toEqual([CAPACITY_PATH_ENV]);
  });

  test('the ledger sits under userData, not inside a user project folder', () => {
    const userData = path.join(path.sep, 'Users', 'x', 'Library', 'Application Support', 'Bimax');
    const ledger = workerCapacityEnvironment(userData)[CAPACITY_PATH_ENV];

    expect(ledger.startsWith(userData + path.sep)).toBe(true);
    // A budget written into one of the projects it governs would be deleted with that project, and
    // would leak the existence of other Threads into a repository the user may commit.
    expect(ledger.startsWith(A)).toBe(false);
    expect(ledger.startsWith(B)).toBe(false);
  });

  test('without the wiring, two Threads get two ledgers — the defect this closes', () => {
    // The over-refusing direction, asserted deliberately: this is what the code did before WP-1,
    // and a green suite here after someone deletes the spawn-site wiring would be a false green.
    delete process.env[CAPACITY_PATH_ENV];

    expect(resolveCapacityContext(A).path).not.toBe(resolveCapacityContext(B).path);
  });
});
