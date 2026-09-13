import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TransactionManager, globalTransactionManager } from '../core/transaction.manager';
import { createEditFileTool } from '../tools/implementations/edit.tool';
import { createWriteFileTool, createDeleteTool } from '../tools/implementations/file.tool';
import { createMultiEditTool } from '../tools/implementations/multiedit.tool';
import { IGovernor } from '../core/interfaces';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

/**
 * Rollback regressions for the two defects reproduced on 2026-09-07 against the real module
 * (`docs/product-reset/competitive/evidence/2026-09-08-plan-recheck/transaction-result.json`), plus
 * the read-error and failed-restoration cases that reproduction left open.
 *
 * Every case drives the real TransactionManager against a real temporary directory. The old
 * implementation fails these: it used `originalContent === ''` to mean "the file did not exist", so
 * an existing empty file was DELETED and an unreadable file was treated as new; it blind-wrote the
 * snapshot back over whatever was there, so a human edit made after the agent's write was lost; it
 * read and wrote `utf8`, so non-UTF-8 bytes came back corrupted; and it cleared its records before
 * restoring, so a failed restore dropped the only copy of the original.
 */
describe('TransactionManager rollback — existence, concurrency and recoverability', () => {
  let dir: string;
  let recoveryRoot: string;
  const isRoot = typeof process.getuid === 'function' && process.getuid!() === 0;

  const tm = () => new TransactionManager({ recoveryRoot });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-tx-'));
    recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-tx-recovery-'));
  });
  afterEach(async () => {
    // Restore any permission bits a case removed, or the cleanup itself fails.
    await fs.chmod(dir, 0o755).catch(() => {});
    for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
      await fs.chmod(path.join(dir, entry), 0o644).catch(() => {});
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(recoveryRoot, { recursive: true, force: true }).catch(() => {});
  });

  const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);

  // --- Defect 1: an existing empty file is a file, not an absent one ---------------------------

  it('keeps an existing empty file that the transaction wrote to, and restores it empty', async () => {
    const file = path.join(dir, 'empty.txt');
    await fs.writeFile(file, '');

    const tx = tm();
    tx.begin('TX-EMPTY');
    await tx.trackEdit(file, 'agent change');
    await fs.writeFile(file, 'agent change');
    const result = await tx.rollbackDetailed();

    expect(await exists(file)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('');
    expect(result.entries).toEqual([
      expect.objectContaining({ absPath: file, status: 'restored', verified: true }),
    ]);
  });

  it('still deletes a file the transaction actually created', async () => {
    const file = path.join(dir, 'created.txt');

    const tx = tm();
    tx.begin('TX-NEW');
    await tx.trackEdit(file, 'agent-created');
    await fs.writeFile(file, 'agent-created');
    const result = await tx.rollbackDetailed();

    expect(await exists(file)).toBe(false);
    expect(result.entries[0].status).toBe('removed');
  });

  it('restores an ordinary non-empty file', async () => {
    const file = path.join(dir, 'plain.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-PLAIN');
    await tx.trackEdit(file, 'agent change');
    await fs.writeFile(file, 'agent change');
    await tx.rollback();

    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  // --- Defect 2: a change made after the transaction wrote is not ours to overwrite -------------

  it('keeps a later human edit instead of overwriting it, and retains the original elsewhere', async () => {
    const file = path.join(dir, 'contested.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-HUMAN');
    await tx.trackEdit(file, 'agent change');
    await fs.writeFile(file, 'agent change');
    await fs.writeFile(file, 'later human edit'); // somebody else, after the agent wrote

    const result = await tx.rollbackDetailed();

    expect(await fs.readFile(file, 'utf8')).toBe('later human edit');
    const entry = result.entries[0];
    expect(entry.status).toBe('conflict');
    expect(entry.recoveryPath).toBeTruthy();
    expect(await fs.readFile(entry.recoveryPath!, 'utf8')).toBe('original');
    // The receipt must not claim a restoration that did not happen.
    expect(result.message).toMatch(/0 restored/);
    expect(result.message).toMatch(/1 kept \(changed after this transaction\)/);
    expect(result.message).not.toMatch(/restored 1 file/);
  });

  it('keeps a file somebody re-created at a path the transaction had created', async () => {
    const file = path.join(dir, 'recreated-by-human.txt');

    const tx = tm();
    tx.begin('TX-RECREATE');
    await tx.trackEdit(file, 'agent-created');
    await fs.writeFile(file, 'agent-created');
    await fs.writeFile(file, 'human wrote this instead');

    const result = await tx.rollbackDetailed();

    expect(await fs.readFile(file, 'utf8')).toBe('human wrote this instead');
    expect(result.entries[0].status).toBe('conflict');
  });

  it('restores a path the transaction wrote to more than once', async () => {
    const file = path.join(dir, 'twice.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-TWICE');
    await tx.trackEdit(file, 'first');
    await fs.writeFile(file, 'first');
    await tx.trackEdit(file, 'second');
    await fs.writeFile(file, 'second');
    const result = await tx.rollbackDetailed();

    expect(await fs.readFile(file, 'utf8')).toBe('original');
    expect(result.entries[0].status).toBe('restored');
  });

  it('overwrites a conflicting change only when force is asked for, and keeps what it discarded', async () => {
    const file = path.join(dir, 'forced.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-FORCE');
    await tx.trackEdit(file, 'agent change');
    await fs.writeFile(file, 'agent change');
    await fs.writeFile(file, 'later human edit');

    const result = await tx.rollbackDetailed({ force: true });

    expect(await fs.readFile(file, 'utf8')).toBe('original');
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ status: 'restored', detail: 'forced over a newer change' }),
    );
  });

  // --- Read errors are not evidence of absence --------------------------------------------------

  it('reports an unreadable file as unprotected and does not delete it', async () => {
    if (isRoot) return; // root ignores the permission bits this case depends on
    const file = path.join(dir, 'locked.txt');
    await fs.writeFile(file, 'secret original');
    await fs.chmod(file, 0o000);

    const tx = tm();
    tx.begin('TX-LOCKED');
    const track = await tx.trackEdit(file, 'agent change');
    expect(track).toEqual(
      expect.objectContaining({ tracked: true, baseline: 'unreadable', protectedByTx: false }),
    );
    expect(track.message).toMatch(/EACCES/);

    const result = await tx.rollbackDetailed();
    expect(result.entries[0].status).toBe('unprotected');
    expect(await exists(file)).toBe(true);
    expect(result.message).toMatch(/NOT protected/);
    expect(result.message).toMatch(/0 restored/);

    await fs.chmod(file, 0o644);
    expect(await fs.readFile(file, 'utf8')).toBe('secret original');
  });

  it('reports a directory as unprotected rather than treating it as a new file', async () => {
    const sub = path.join(dir, 'a-directory');
    await fs.mkdir(sub);

    const tx = tm();
    tx.begin('TX-DIR');
    const track = await tx.trackEdit(sub, 'agent change');
    expect(track.protectedByTx).toBe(false);
    const result = await tx.rollbackDetailed();

    expect(result.entries[0].status).toBe('unprotected');
    expect(await exists(sub)).toBe(true);
  });

  it('reports a file past the snapshot ceiling as unprotected instead of deleting it', async () => {
    const file = path.join(dir, 'huge.txt');
    await fs.writeFile(file, 'x'.repeat(4096));

    // The property under test is "a baseline we did not capture is never treated as absent", not
    // the size of the ceiling — so the ceiling is injected rather than writing a 64 MiB fixture.
    const tx = new TransactionManager({ recoveryRoot, maxSnapshotBytes: 1024 });
    tx.begin('TX-HUGE');
    const track = await tx.trackEdit(file, 'agent change');
    expect(track.protectedByTx).toBe(false);
    expect(track.message).toMatch(/too large to snapshot/);

    const result = await tx.rollbackDetailed();
    expect(result.entries[0].status).toBe('unprotected');
    expect(await fs.readFile(file, 'utf8')).toBe('x'.repeat(4096));
  });

  it('names the unprotected paths on commit as well as on rollback', async () => {
    const sub = path.join(dir, 'commit-dir');
    await fs.mkdir(sub);
    const tx = tm();
    tx.begin('TX-COMMIT');
    await tx.trackEdit(sub, 'agent change');
    const msg = tx.commit();
    expect(msg).toMatch(/never protected/);
    expect(msg).toContain(sub);
  });

  // --- A failed restoration keeps the original recoverable --------------------------------------

  it('retains the original after a failed restoration and can apply it on a later recover()', async () => {
    if (isRoot) return; // root writes into a read-only directory, so the failure cannot be staged
    const file = path.join(dir, 'unwritable.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-FAIL');
    await tx.trackEdit(file, 'agent change');
    await fs.writeFile(file, 'agent change');
    await fs.chmod(dir, 0o555); // readable, so the state is observable; not writable, so restore fails

    const result = await tx.rollbackDetailed();
    expect(result.entries[0].status).toBe('failed');
    expect(result.pending).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('agent change');

    // The pre-transaction bytes survive the failure, both in memory and on disk.
    const pending = tx.pendingRecovery();
    expect(pending).toEqual(expect.objectContaining({ id: 'TX-FAIL', paths: [file] }));
    expect(await fs.readFile(result.entries[0].recoveryPath!, 'utf8')).toBe('original');
    const manifest = JSON.parse(await fs.readFile(path.join(pending!.dir!, 'manifest.json'), 'utf8'));
    expect(manifest.paths[0]).toEqual(expect.objectContaining({ absPath: file, status: 'failed' }));
    expect(result.message).toMatch(/Run \/tx recover/);

    await fs.chmod(dir, 0o755);
    const recovered = await tx.recover();
    expect(await fs.readFile(file, 'utf8')).toBe('original');
    expect(recovered).toMatch(/1 restored/);
    expect(tx.pendingRecovery()).toBeNull();
  });

  // --- The bytes that come back are the bytes that were there ------------------------------------

  it('restores non-UTF-8 bytes exactly', async () => {
    const file = path.join(dir, 'binary.bin');
    const original = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x80, 0x0a]);
    await fs.writeFile(file, original);

    const tx = tm();
    tx.begin('TX-BINARY');
    await tx.trackEdit(file, Buffer.from('agent change'));
    await fs.writeFile(file, 'agent change');
    await tx.rollback();

    expect(Buffer.compare(await fs.readFile(file), original)).toBe(0);
  });

  it('restores the file mode when it re-creates a deleted file', async () => {
    if (isRoot) return;
    const file = path.join(dir, 'moded.sh');
    await fs.writeFile(file, '#!/bin/sh\n');
    await fs.chmod(file, 0o750);

    const tx = tm();
    tx.begin('TX-MODE');
    await tx.trackEdit(file, null); // a delete: after this tool runs the path is gone
    await fs.rm(file);
    const result = await tx.rollbackDetailed();

    expect(result.entries[0].status).toBe('recreated');
    expect(await fs.readFile(file, 'utf8')).toBe('#!/bin/sh\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o750);
  });

  it('writes through a symlink instead of replacing it', async () => {
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await fs.writeFile(target, 'original');
    await fs.symlink(target, link);

    const tx = tm();
    tx.begin('TX-LINK');
    await tx.trackEdit(link, 'agent change');
    await fs.writeFile(link, 'agent change');
    await tx.rollback();

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });

  // --- The undeclared-intent policy, pinned deliberately ----------------------------------------

  it('keeps the on-disk bytes when the caller never declared its write, rather than guessing', async () => {
    const file = path.join(dir, 'undeclared.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-UNDECLARED');
    await tx.trackEdit(file); // legacy call shape: no declared write
    await fs.writeFile(file, 'agent change');
    const result = await tx.rollbackDetailed();

    // Strict on purpose. A caller that does not say what it wrote cannot have its write undone,
    // because an undo would be indistinguishable from erasing somebody else's edit. The bytes stay,
    // the entry is unverified, and the receipt says why.
    expect(await fs.readFile(file, 'utf8')).toBe('agent change');
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ status: 'conflict', verified: false }),
    );
    expect(result.message).toMatch(/never declared what it wrote/);
    expect(await fs.readFile(result.entries[0].recoveryPath!, 'utf8')).toBe('original');
  });

  it('force still restores an undeclared write when the user asks for it', async () => {
    const file = path.join(dir, 'undeclared-forced.txt');
    await fs.writeFile(file, 'original');

    const tx = tm();
    tx.begin('TX-UNDECLARED-FORCE');
    await tx.trackEdit(file);
    await fs.writeFile(file, 'agent change');
    await tx.rollback({ force: true });

    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  // --- Bookkeeping ------------------------------------------------------------------------------

  it('does not track edits into a transaction that is already being rolled back', async () => {
    const file = path.join(dir, 'closed.txt');
    await fs.writeFile(file, 'original');
    const tx = tm();
    tx.begin('TX-CLOSED');
    await tx.trackEdit(file, 'agent change');
    await fs.writeFile(file, 'agent change');
    await tx.rollback();

    expect(tx.isOpen()).toBe(false);
    expect(await tx.trackEdit(file, 'late')).toEqual(
      expect.objectContaining({ tracked: false }),
    );
    expect(await tx.rollback()).toBe('No open transaction to roll back.');
  });
});

/**
 * The manager can only tell its own write apart from somebody else's if the mutating tools say what
 * they are writing. These cases fail if a caller drops that argument: the rollback degrades to a
 * conflict (the user's bytes are still safe) instead of restoring, and `verified` goes false.
 */
describe('mutation tools declare what they write, so rollback can verify it', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-tx-tools-')); });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (globalTransactionManager.isOpen()) await globalTransactionManager.rollback();
  });

  it('EditFileTool: a tracked edit rolls back verified', async () => {
    const file = path.join(dir, 'edited.ts');
    await fs.writeFile(file, 'export const a = 1;\n');
    globalTransactionManager.begin('TX-TOOL-EDIT');
    const res = await createEditFileTool(governor).execute(
      { path: file, oldString: 'const a = 1', newString: 'const a = 2' }, { cwd: dir },
    );
    expect(String(res)).toMatch(/Edited/);

    const result = await globalTransactionManager.rollbackDetailed();
    expect(result.entries).toEqual([
      expect.objectContaining({ absPath: file, status: 'restored', verified: true }),
    ]);
    expect(await fs.readFile(file, 'utf8')).toBe('export const a = 1;\n');
  });

  it('WriteFileTool: overwriting an existing EMPTY file rolls back to empty, not to deleted', async () => {
    const file = path.join(dir, 'note.md');
    await fs.writeFile(file, '');
    globalTransactionManager.begin('TX-TOOL-WRITE');
    await createWriteFileTool(governor).execute({ path: file, content: 'agent draft\n' }, { cwd: dir });

    const result = await globalTransactionManager.rollbackDetailed();
    expect(result.entries).toEqual([
      expect.objectContaining({ absPath: file, status: 'restored', verified: true }),
    ]);
    expect(await fs.access(file).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('DeleteTool: a deleted file comes back on rollback', async () => {
    const file = path.join(dir, 'doomed.txt');
    await fs.writeFile(file, 'keep me');
    globalTransactionManager.begin('TX-TOOL-DELETE');
    await createDeleteTool(governor).execute({ path: file }, { cwd: dir });
    expect(await fs.access(file).then(() => true).catch(() => false)).toBe(false);

    const result = await globalTransactionManager.rollbackDetailed();
    expect(result.entries).toEqual([
      expect.objectContaining({ absPath: file, status: 'recreated', verified: true }),
    ]);
    expect(await fs.readFile(file, 'utf8')).toBe('keep me');
  });

  it('MultiEditTool: every file in the batch rolls back verified', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await fs.writeFile(a, 'alpha original');
    await fs.writeFile(b, 'beta original');
    globalTransactionManager.begin('TX-TOOL-MULTI');
    await createMultiEditTool(governor).execute({
      edits: [
        { path: a, oldString: 'alpha original', newString: 'alpha NEW' },
        { path: b, oldString: 'beta original', newString: 'beta NEW' },
      ],
    }, { cwd: dir });

    const result = await globalTransactionManager.rollbackDetailed();
    expect(result.entries.every(e => e.verified)).toBe(true);
    expect(result.entries.map(e => e.status).sort()).toEqual(['restored', 'restored']);
    expect(await fs.readFile(a, 'utf8')).toBe('alpha original');
    expect(await fs.readFile(b, 'utf8')).toBe('beta original');
  });
});
