import fs = require('fs/promises');
import * as os from 'os';
import * as path from 'path';
import { TransactionManager } from '../core/transaction.manager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('transaction sprint — lifecycle and filesystem end states', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-tx-sprint-')); });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { force: true, recursive: true });
  });
  const manager = () => new TransactionManager({ recoveryRoot: dir });

  function gateCapture(tx: TransactionManager) {
    const gate = deferred<void>();
    const capture = (tx as any).capture.bind(tx);
    const spy = jest.spyOn(tx as any, 'capture').mockImplementation(async (...args: any[]) => {
      await gate.promise;
      return capture(...args);
    });
    return { gate, spy };
  }

  it('coalesces concurrent snapshots of one path and keeps every declared intent', async () => {
    const file = path.join(dir, 'same');
    await fs.writeFile(file, 'original');
    const tx = manager();
    tx.begin('SAME');
    const { gate, spy } = gateCapture(tx);
    const first = tx.trackEdit(file, 'first');
    const second = tx.trackEdit(file, 'second');
    gate.resolve();
    await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await fs.writeFile(file, 'second');
    const result = await tx.rollbackDetailed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('restored');
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('refuses commit while a snapshot is pending, keeping it in its original transaction', async () => {
    const tx = manager();
    tx.begin('FIRST');
    const { gate } = gateCapture(tx);
    const pending = tx.trackEdit(path.join(dir, 'new'), 'new');
    const message = tx.commit();
    tx.begin('SECOND');
    gate.resolve();
    await pending;
    expect(message).toMatch(/snapshot.*progress/i);
    expect(tx.currentId()).toBe('FIRST');
    expect(tx.commit()).toContain('1 file(s)');
  });

  it('refuses rollback during snapshot capture instead of closing under the pending caller', async () => {
    const tx = manager();
    tx.begin('CAPTURE');
    const { gate } = gateCapture(tx);
    // Attach rejection handling immediately so the old race is observed, never unhandled.
    const pending = tx.trackEdit(path.join(dir, 'new'), 'new').then(v => v, e => e);
    const result = await tx.rollbackDetailed();
    gate.resolve();
    const tracked = await pending;
    expect(result.message).toMatch(/snapshot.*progress/i);
    expect(tracked).not.toBeInstanceOf(Error);
    expect(tx.currentId()).toBe('CAPTURE');
    tx.commit();
  });

  it('blocks a new transaction and file tracking while restoration is running', async () => {
    const file = path.join(dir, 'busy');
    await fs.writeFile(file, 'original');
    const tx = manager();
    tx.begin('BUSY');
    await tx.trackEdit(file, 'agent');
    await fs.writeFile(file, 'agent');
    const { gate } = gateCapture(tx);
    const undo = tx.rollbackDetailed();
    const begin = tx.begin('TOO-EARLY');
    const tracking = tx.trackEdit(path.join(dir, 'other'), 'other').then(v => v, e => e);
    gate.resolve();
    await undo;
    expect(begin).toMatch(/restoration.*progress/i);
    expect(await tracking).toBeInstanceOf(Error);
    expect(tx.isOpen()).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('never claims automatic rollback succeeded when capture is still pending', async () => {
    const tx = manager();
    tx.begin('AUTO');
    const { gate } = gateCapture(tx);
    const pending = tx.trackEdit(path.join(dir, 'new'), 'new');
    const receipt = await tx.autoRollback('failed-file', 'injected failure');
    gate.resolve();
    await pending;
    expect(receipt).toContain('Automatic rollback could not start');
    expect(receipt).toContain('Snapshot capture is in progress');
    expect(receipt).not.toContain('Auto-rolled back');
    expect(tx.currentId()).toBe('AUTO');
    tx.commit();
  });

  it('keeps previous recovery records when a later rollback succeeds', async () => {
    const file = path.join(dir, 'human');
    await fs.writeFile(file, 'original');
    const tx = manager();
    tx.begin('CONFLICT');
    await tx.trackEdit(file, 'agent');
    await fs.writeFile(file, 'human');
    await tx.rollbackDetailed();
    const saved = tx.pendingRecovery();
    tx.begin('LATER');
    await tx.rollbackDetailed();
    expect(tx.pendingRecovery()).toEqual(saved);
    expect(await fs.readFile(file, 'utf8')).toBe('human');
  });

  it('refuses recovery inside a newer open transaction', async () => {
    const file = path.join(dir, 'recover');
    await fs.writeFile(file, 'original');
    const tx = manager();
    tx.begin('OLD');
    await tx.trackEdit(file, 'agent');
    await fs.writeFile(file, 'human');
    await tx.rollbackDetailed();
    tx.begin('NEW');
    await tx.trackEdit(file, 'new-agent');
    await fs.writeFile(file, 'agent');
    const result = await tx.recover();
    expect(result).toMatch(/open transaction/i);
    expect(await fs.readFile(file, 'utf8')).toBe('agent');
    tx.commit();
  });

  it('reports a mode-only external change as a conflict; force restores bytes AND mode', async () => {
    const file = path.join(dir, 'mode');
    await fs.writeFile(file, 'original', { mode: 0o640 });
    const tx = manager();
    tx.begin('MODE');
    await tx.trackEdit(file, 'agent');
    await fs.chmod(file, 0o600);
    const result = await tx.rollbackDetailed();
    expect(result.entries[0].status).toBe('conflict');
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o600);

    const forced = manager();
    await fs.chmod(file, 0o640);
    forced.begin('FORCED-MODE');
    await forced.trackEdit(file, 'agent');
    await fs.chmod(file, 0o600);
    expect((await forced.rollbackDetailed({ force: true })).entries[0].status).toBe('restored');
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o640);
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('verifies forced rollback even when the current file exceeds the read ceiling', async () => {
    const file = path.join(dir, 'force');
    await fs.writeFile(file, 'old');
    const tx = new TransactionManager({ recoveryRoot: dir, maxSnapshotBytes: 4 });
    tx.begin('FORCE-VERIFY');
    await tx.trackEdit(file, 'new');
    await fs.writeFile(file, 'too large');
    jest.spyOn(tx as any, 'writeBack').mockResolvedValue(undefined);
    const result = await tx.rollbackDetailed({ force: true });
    expect(result.entries[0].status).toBe('failed');
    expect(result.pending).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('too large');
    expect(tx.pendingRecovery()?.paths).toContain(file);
  });

  it('reserves aggregate memory before concurrent reads and releases successful baselines', async () => {
    const files = [path.join(dir, 'a'), path.join(dir, 'b')];
    await Promise.all(files.map(file => fs.writeFile(file, 'old!')));
    const tx = new TransactionManager({ recoveryRoot: dir, maxTotalSnapshotBytes: 4 });
    tx.begin('BUDGET');
    const tracked = await Promise.all(files.map(file => tx.trackEdit(file, 'agent')));
    expect(tracked.filter(r => r.protectedByTx)).toHaveLength(1);
    expect(tracked.find(r => !r.protectedByTx)?.message).toMatch(/aggregate limit/);
    expect(tx.status()).toMatchObject({ paths: 2, protectedPaths: 1, unprotectedPaths: 1, snapshotBytes: 4, heldSnapshotBytes: 4, pendingSnapshots: 0 });
    await Promise.all(files.map(file => fs.writeFile(file, 'agent')));
    const result = await tx.rollbackDetailed();
    expect(result.entries.map(e => e.status).sort()).toEqual(['restored', 'unprotected']);
    for (let i = 0; i < files.length; i++) {
      expect(await fs.readFile(files[i], 'utf8')).toBe(tracked[i].protectedByTx ? 'old!' : 'agent');
    }
    expect(tx.status().heldSnapshotBytes).toBe(0);
  });

  it('counts retained recovery bytes across transactions and frees them after strict recovery', async () => {
    const file = path.join(dir, 'old');
    const next = path.join(dir, 'next');
    await fs.writeFile(file, 'old!');
    await fs.writeFile(next, 'next');
    const tx = new TransactionManager({ recoveryRoot: dir, maxTotalSnapshotBytes: 4 });
    tx.begin('RETAIN');
    await tx.trackEdit(file, 'agent');
    await fs.writeFile(file, 'human');
    await tx.rollbackDetailed();
    expect(tx.status().heldSnapshotBytes).toBe(4);
    tx.begin('NEXT');
    expect((await tx.trackEdit(next, 'new')).protectedByTx).toBe(false);
    tx.commit();
    expect(tx.status().heldSnapshotBytes).toBe(4);
    await fs.writeFile(file, 'agent');
    await tx.recover();
    expect(await fs.readFile(file, 'utf8')).toBe('old!');
    expect(tx.pendingRecovery()).toBeNull();
    expect(tx.status().heldSnapshotBytes).toBe(0);
    tx.begin('FREE');
    expect((await tx.trackEdit(next, 'new')).protectedByTx).toBe(true);
    tx.commit();
    expect(tx.status().heldSnapshotBytes).toBe(0);
  });

  it('retains every unresolved transaction and serializes recovery callers', async () => {
    const tx = manager();
    for (const id of ['FIRST', 'SECOND']) {
      const file = path.join(dir, id);
      await fs.writeFile(file, `original-${id}`);
      tx.begin(id);
      await tx.trackEdit(file, `agent-${id}`);
      await fs.writeFile(file, `human-${id}`);
      await tx.rollbackDetailed();
    }
    expect(tx.pendingRecoveries().map(r => r.id)).toEqual(['FIRST', 'SECOND']);
    expect(tx.begin('FIRST')).toMatch(/recovery records/);
    expect(tx.isOpen()).toBe(false);
    const { gate } = gateCapture(tx);
    const recover = tx.recover();
    const other = tx.recover();
    const rollback = await tx.rollbackDetailed();
    const begin = tx.begin('BUSY');
    gate.resolve();
    const message = await recover;
    expect(await other).toMatch(/restoration.*progress/i);
    expect(rollback.id).toBe('');
    expect(begin).toMatch(/restoration.*progress/i);
    expect(message).toContain('FIRST');
    expect(message).toContain('SECOND');
    expect(tx.pendingRecoveries()).toHaveLength(2);
    for (const id of ['FIRST', 'SECOND']) {
      expect(await fs.readFile(path.join(dir, id), 'utf8')).toBe(`human-${id}`);
    }
  });

  function interceptRead(change: (handle: fs.FileHandle, read: fs.FileHandle['read']) => void) {
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementationOnce(async (...args: any[]) => {
      const handle: fs.FileHandle = await (open as any)(...args);
      change(handle, handle.read.bind(handle));
      return handle;
    });
  }

  it('fills short reads without treating a partial chunk as the complete baseline', async () => {
    const file = path.join(dir, 'short');
    await fs.writeFile(file, 'original');
    const tx = manager();
    tx.begin('SHORT');
    let reads = 0;
    interceptRead((handle, read) => {
      jest.spyOn(handle, 'read').mockImplementation(async (...args: any[]) => {
        reads++;
        const [buffer, offset, length, position] = args;
        return (read as any)(buffer, offset, Math.min(length, 2), position);
      });
    });
    expect((await tx.trackEdit(file, 'agent')).protectedByTx).toBe(true);
    expect(reads).toBe(4);
    await fs.writeFile(file, 'agent');
    await tx.rollbackDetailed();
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('rejects a growing file and releases its reservation instead of retaining a torn snapshot', async () => {
    const file = path.join(dir, 'growing');
    await fs.writeFile(file, 'old!');
    const tx = new TransactionManager({ recoveryRoot: dir, maxSnapshotBytes: 4, maxTotalSnapshotBytes: 4 });
    tx.begin('GROW');
    let allocated = 0;
    interceptRead((handle, read) => {
      jest.spyOn(handle, 'read').mockImplementationOnce(async (...args: any[]) => {
        allocated = args[0].length;
        const result = await (read as any)(...args);
        await fs.appendFile(file, 'grew');
        return result;
      });
    });
    const result = await tx.trackEdit(file, 'agent');
    expect(allocated).toBe(4);
    expect(result).toMatchObject({ baseline: 'unreadable', protectedByTx: false });
    expect(result.message).toMatch(/changed during snapshot/);
    expect(tx.status().heldSnapshotBytes).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe('old!grew');
    tx.commit();
  });

  it('rejects a path replaced during the read instead of snapshotting the detached file', async () => {
    const file = path.join(dir, 'replaced');
    await fs.writeFile(file, 'old');
    const tx = manager();
    tx.begin('REPLACE');
    interceptRead((handle, read) => {
      jest.spyOn(handle, 'read').mockImplementationOnce(async (...args: any[]) => {
        const result = await (read as any)(...args);
        await fs.rename(file, `${file}.old`);
        await fs.writeFile(file, 'new');
        return result;
      });
    });
    expect((await tx.trackEdit(file, 'agent')).protectedByTx).toBe(false);
    expect(tx.status().heldSnapshotBytes).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe('new');
    expect(await fs.readFile(`${file}.old`, 'utf8')).toBe('old');
    tx.commit();
  });

  it('never treats a dangling symlink as an absent baseline that rollback may remove', async () => {
    const link = path.join(dir, 'dangling');
    await fs.symlink(path.join(dir, 'missing-target'), link);
    const tx = manager();
    tx.begin('DANGLING');
    expect((await tx.trackEdit(link, 'agent')).protectedByTx).toBe(false);
    await fs.writeFile(link, 'agent');
    expect((await tx.rollbackDetailed()).entries[0].status).toBe('unprotected');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(link, 'utf8')).toBe('agent');
  });

  it('fails restoration when read-back finds wrong permissions even if bytes match', async () => {
    const file = path.join(dir, 'verify-mode');
    await fs.writeFile(file, 'old', { mode: 0o640 });
    const tx = manager();
    tx.begin('VERIFY-MODE');
    await tx.trackEdit(file, 'agent');
    await fs.writeFile(file, 'agent');
    const write = (tx as any).writeBack.bind(tx);
    jest.spyOn(tx as any, 'writeBack').mockImplementation(async (...args: any[]) => {
      await write(...args);
      await fs.chmod(file, 0o600);
    });
    const result = await tx.rollbackDetailed();
    expect(result.entries[0].status).toBe('failed');
    expect(result.pending).toBe(1);
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o600);
    expect(tx.pendingRecovery()?.paths).toContain(file);
  });

  it('propagates a symlink chmod failure and retains the recovery baseline', async () => {
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    await fs.writeFile(target, 'old');
    await fs.symlink(target, link);
    const tx = manager();
    tx.begin('CHMOD');
    await tx.trackEdit(link, 'agent');
    await fs.writeFile(link, 'agent');
    jest.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('injected chmod failure'));
    expect((await tx.rollbackDetailed()).entries[0].status).toBe('failed');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(tx.pendingRecovery()?.paths).toContain(link);
  });

  it('validates memory budgets, including a legitimate zero-byte budget', async () => {
    for (const value of [-1, NaN, Infinity, 1.5]) {
      expect(() => new TransactionManager({ maxTotalSnapshotBytes: value })).toThrow(RangeError);
      expect(() => new TransactionManager({ maxSnapshotBytes: value })).toThrow(RangeError);
    }
    const empty = path.join(dir, 'empty');
    await fs.writeFile(empty, '');
    const tx = new TransactionManager({ recoveryRoot: dir, maxTotalSnapshotBytes: 0 });
    tx.begin('ZERO');
    expect((await tx.trackEdit(empty, 'new')).protectedByTx).toBe(true);
    expect((await tx.trackEdit(path.join(dir, 'absent'), 'new')).protectedByTx).toBe(true);
    expect(tx.status().heldSnapshotBytes).toBe(0);
    tx.commit();
  });
});
