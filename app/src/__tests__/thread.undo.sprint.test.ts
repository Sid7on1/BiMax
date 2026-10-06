import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changeHistory, journalFile, lastUndoable, undoBackTo, undoLast, type BinOps } from '../main/thread.undo';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Bimax Thread undo sprint — containment and real end states', () => {
  let base: string;
  let root: string;
  let state: string;
  let outside: string;
  let binRoot: string;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-undo-sprint-')));
    root = path.join(base, 'root'); state = path.join(base, 'state'); outside = path.join(base, 'outside');
    const home = path.join(base, 'home'); binRoot = path.join(home, '.Trash');
    for (const dir of [root, state, outside, binRoot]) fs.mkdirSync(dir, { recursive: true });
    jest.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(base, { force: true, recursive: true }); });
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const append = (...records: object[]) => {
    fs.mkdirSync(path.dirname(journalFile(state)), { recursive: true });
    fs.appendFileSync(journalFile(state), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  };
  const change = (ops: object[], id = 'change') => append({ type: 'change', id, at: 1, title: id, tool: 'fixture', ops });
  const backup = (name = 'saved') => put(path.join(state, '.bimax', 'undo', 'backups', 'change', name), 'before');
  const realBin = (): BinOps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      async moveToBin(target) {
        calls.push(target);
        const dest = path.join(binRoot, `${calls.length}-${path.basename(target)}`);
        fs.renameSync(target, dest);
        return dest;
      },
      async restoreFromBin(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(source, target); },
    };
  };

  it('preflights every saved copy before changing any file; missing backups stay pending', async () => {
    const target = put(path.join(root, 'replaced'), 'after');
    const created = put(path.join(root, 'created'), 'created');
    const missing = path.join(state, '.bimax', 'undo', 'backups', 'change', 'missing');
    change([{ op: 'restore', path: target, backup: missing }, { op: 'create', path: created }]);
    const bin = realBin();
    const result = await undoLast(state, root, bin).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]);
    expect(fs.readFileSync(created, 'utf8')).toBe('created');
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
    expect(lastUndoable(state)?.id).toBe('change');
  });

  it('refuses a project path reached through a symlinked parent outside the folder', async () => {
    const foreign = put(path.join(outside, 'valuable'), 'outside bytes');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    change([{ op: 'create', path: path.join(root, 'escape', 'valuable') }]);
    const bin = realBin();
    const result = await undoLast(state, root, bin).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('outside bytes');
    expect(lastUndoable(state)?.id).toBe('change');
  });

  it('refuses a saved copy that is a symlink to an outside file', async () => {
    const target = put(path.join(root, 'target'), 'after');
    const foreign = put(path.join(outside, 'secret'), 'outside bytes');
    const saved = backup(); fs.rmSync(saved); fs.symlinkSync(foreign, saved);
    change([{ op: 'restore', path: target, backup: saved }]);
    const bin = realBin();
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
    expect(fs.readFileSync(foreign, 'utf8')).toBe('outside bytes');
  });

  it('refuses a symlinked journal directory before reading or appending mutation receipts', async () => {
    const foreignJournal = path.join(outside, 'journal');
    fs.mkdirSync(foreignJournal);
    fs.mkdirSync(path.join(state, '.bimax'));
    fs.symlinkSync(foreignJournal, path.join(state, '.bimax', 'undo'));
    const created = put(path.join(root, 'created'), 'kept');
    change([{ op: 'create', path: created }]);
    const bytes = fs.readFileSync(journalFile(state));
    const bin = realBin();
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]);
    expect(fs.readFileSync(created, 'utf8')).toBe('kept');
    expect(fs.readFileSync(journalFile(state))).toEqual(bytes);
  });

  it('does not mark a creation undone when the Bin callback leaves it in place', async () => {
    const target = put(path.join(root, 'created'), 'kept');
    change([{ op: 'create', path: target }]);
    const bin: BinOps = { moveToBin: jest.fn().mockResolvedValue(null), restoreFromBin: jest.fn() };
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(target, 'utf8')).toBe('kept');
    expect(lastUndoable(state)?.id).toBe('change');
  });

  it('does not mark a Bin restoration undone when the callback produces no destination', async () => {
    const source = put(path.join(binRoot, 'saved'), 'before');
    const target = path.join(root, 'target');
    change([{ op: 'trash', path: target, trashPath: source }]);
    const bin: BinOps = { moveToBin: jest.fn(), restoreFromBin: jest.fn().mockResolvedValue(undefined) };
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toBe('before');
    expect(lastUndoable(state)?.id).toBe('change');
  });

  it('stages and verifies restoration before moving the current version to the Bin', async () => {
    const target = put(path.join(root, 'target'), 'after');
    change([{ op: 'restore', path: target, backup: backup() }]);
    jest.spyOn(asyncFs, 'copyFile').mockResolvedValueOnce(undefined);
    const bin = realBin();
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
    expect(lastUndoable(state)?.id).toBe('change');
  });

  it('serializes concurrent undo calls sharing a journal, including a state-folder alias', async () => {
    const target = put(path.join(root, 'target'), 'made');
    change([{ op: 'create', path: target }]);
    const alias = path.join(base, 'state-alias'); fs.symlinkSync(state, alias);
    const entered = deferred(); const release = deferred(); const secondSettledOrEntered = deferred();
    const bin = realBin();
    const move = bin.moveToBin.bind(bin);
    let calls = 0;
    bin.moveToBin = async p => { calls++; entered.resolve(); if (calls === 2) secondSettledOrEntered.resolve(); await release.promise; return move(p); };
    const first = undoLast(state, root, bin).catch(error => error);
    await entered.promise;
    const second = undoLast(alias, root, bin).catch(error => error);
    void second.then(() => secondSettledOrEntered.resolve());
    // Release even a broken second caller so a mutant fails assertions, never a fixture timeout.
    await secondSettledOrEntered.promise;
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual({ title: 'change' });
    expect(results[1]).toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(bin.calls).toEqual([target]);
    expect(lastUndoable(state)).toBeNull();
  });

  it('keeps a missing move pending when neither the old nor the new path can be observed', async () => {
    change([{ op: 'move', from: path.join(root, 'old'), to: path.join(root, 'new') }]);
    expect(await undoLast(state, root, realBin()).catch(error => error)).toBeInstanceOf(Error);
    expect(lastUndoable(state)?.id).toBe('change');
  });

  it('rejects malformed operation kinds instead of interpreting them as Bin restores', async () => {
    const source = put(path.join(binRoot, 'saved'), 'before');
    const target = path.join(root, 'target');
    change([{ op: 'unknown', path: target, trashPath: source }]);
    expect(await undoLast(state, root, realBin()).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toBe('before');
  });

  it('resumes only unfinished steps and preserves edits made after a verified step', async () => {
    const a = put(path.join(root, 'a'), 'after-a'); const b = put(path.join(root, 'b'), 'after-b');
    const savedA = backup('a'); const savedB = backup('b');
    change([{ op: 'restore', path: a, backup: savedA }, { op: 'restore', path: b, backup: savedB }]);
    const bin = realBin(); const move = bin.moveToBin.bind(bin);
    bin.moveToBin = async p => { if (p === a) throw new Error('injected Bin failure'); return move(p); };
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(a, 'utf8')).toBe('after-a'); expect(fs.readFileSync(b, 'utf8')).toBe('before');
    expect(changeHistory(state)[0]).toMatchObject({ completedSteps: 1, totalSteps: 2 });
    put(b, 'human edit after verified undo'); bin.moveToBin = move;
    await expect(undoLast(state, root, bin)).resolves.toEqual({ title: 'change' });
    expect(fs.readFileSync(a, 'utf8')).toBe('before');
    expect(fs.readFileSync(b, 'utf8')).toBe('human edit after verified undo');
    expect(bin.calls).toEqual([b, a]); expect(lastUndoable(state)).toBeNull();
    expect(fs.readdirSync(root).sort()).toEqual(['a', 'b']);
  });

  it('holds the journal lock across an entire undo-back-to batch', async () => {
    const a = put(path.join(root, 'a'), 'a'); const b = put(path.join(root, 'b'), 'b');
    change([{ op: 'create', path: a }], 'a'); change([{ op: 'create', path: b }], 'b');
    const bin = realBin(); const move = bin.moveToBin.bind(bin);
    const entered = deferred(); const release = deferred(); const secondSettledOrEntered = deferred();
    let gatedCalls = 0;
    bin.moveToBin = async p => {
      if (p === a) { gatedCalls++; entered.resolve(); if (gatedCalls === 2) secondSettledOrEntered.resolve(); await release.promise; }
      return move(p);
    };
    const batch = undoBackTo(state, root, bin, 'a'); await entered.promise;
    const second = undoLast(state, root, bin).catch(error => error);
    void second.then(() => secondSettledOrEntered.resolve());
    await secondSettledOrEntered.promise; release.resolve();
    expect(await second).toBeInstanceOf(Error);
    expect(await batch).toEqual({ undone: ['b', 'a'] });
    expect(gatedCalls).toBe(1); expect(bin.calls).toEqual([b, a]); expect(lastUndoable(state)).toBeNull();
  });

  it('reports missing backup coverage as partial and refuses unprotected changes before mutation', async () => {
    const a = put(path.join(root, 'a'), 'kept'); const b = put(path.join(root, 'b'), 'kept');
    change([{ op: 'restore', path: a, backup: path.join(state, '.bimax/undo/backups/missing') }], 'missing');
    expect(changeHistory(state)[0]?.reversibility).toBe('partial');
    change([{ op: 'unprotected', path: a, reason: 'backup unavailable' }, { op: 'create', path: b }], 'unprotected');
    expect(changeHistory(state)[0]?.reversibility).toBe('partial');
    const bin = realBin();
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]); expect(fs.readFileSync(b, 'utf8')).toBe('kept');
    expect(lastUndoable(state)?.id).toBe('unprotected');
  });

  it('restores binary bytes and executable permissions with a bounded streaming verifier', async () => {
    const target = put(path.join(root, 'target'), 'after'); const saved = backup();
    const bytes = Buffer.alloc(192 * 1024 + 19); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.writeFileSync(saved, bytes); fs.chmodSync(saved, 0o751);
    change([{ op: 'restore', path: target, backup: saved }]);
    await undoLast(state, root, realBin());
    expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.statSync(target).mode & 0o777).toBe(0o751);
    expect(lastUndoable(state)).toBeNull();
  });

  it('catches corrupted final bytes instead of recording undo success', async () => {
    const target = put(path.join(root, 'target'), 'after'); change([{ op: 'restore', path: target, backup: backup() }]);
    const rename = asyncFs.rename;
    jest.spyOn(asyncFs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(from).includes('.bimax-undo-')) put(String(to), 'broken'); });
    expect(await undoLast(state, root, realBin()).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(target, 'utf8')).toBe('broken'); expect(lastUndoable(state)?.id).toBe('change');
    expect(changeHistory(state)[0]?.completedSteps).toBe(0);
  });

  it('catches incorrect final permissions instead of recording undo success', async () => {
    const target = put(path.join(root, 'target'), 'after'); const saved = backup(); fs.chmodSync(saved, 0o751);
    change([{ op: 'restore', path: target, backup: saved }]); const rename = asyncFs.rename;
    jest.spyOn(asyncFs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(from).includes('.bimax-undo-')) fs.chmodSync(String(to), 0o600); });
    expect(await undoLast(state, root, realBin()).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600); expect(lastUndoable(state)?.id).toBe('change');
  });

  it('does not accept a copied Bin file whose original remains in the Bin', async () => {
    const source = put(path.join(binRoot, 'saved'), 'before'); const target = path.join(root, 'target');
    change([{ op: 'trash', path: target, trashPath: source }]);
    const bin = realBin(); bin.restoreFromBin = async (from, to) => { fs.copyFileSync(from, to); };
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(source, 'utf8')).toBe('before'); expect(lastUndoable(state)?.id).toBe('change');
  });

  it('refuses an escaped backup parent and a symlinked Bin root', async () => {
    const foreign = put(path.join(outside, 'saved'), 'foreign'); const target = put(path.join(root, 'target'), 'after');
    fs.mkdirSync(path.join(state, '.bimax/undo'), { recursive: true });
    fs.symlinkSync(outside, path.join(state, '.bimax/undo/backups'));
    change([{ op: 'restore', path: target, backup: path.join(state, '.bimax/undo/backups/saved') }]);
    const bin = realBin(); expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]); expect(fs.readFileSync(target, 'utf8')).toBe('after');
    fs.rmSync(journalFile(state)); fs.rmSync(target); fs.rmSync(binRoot, { recursive: true }); fs.symlinkSync(outside, binRoot);
    change([{ op: 'trash', path: target, trashPath: path.join(binRoot, 'saved') }]);
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign'); expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses journal self-mutation and replacement symlinks, but permits safe leaf renames', async () => {
    const project = path.join(root, '.bimax/undo'); fs.mkdirSync(project, { recursive: true });
    const originalState = state; state = root;
    change([{ op: 'create', path: journalFile(state) }]); const bin = realBin();
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error); expect(bin.calls).toEqual([]);
    state = originalState;
    const foreign = put(path.join(outside, 'foreign'), 'kept'); const link = path.join(root, 'link'); fs.symlinkSync(foreign, link);
    change([{ op: 'restore', path: link, backup: backup() }]);
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error); expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    fs.rmSync(journalFile(state));
    const old = path.join(root, '..notes'); change([{ op: 'move', from: old, to: link }]);
    await undoLast(state, root, bin); expect(fs.lstatSync(old).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('kept');
  });

  it('verifies rename callbacks and releases the lock after failure', async () => {
    const to = put(path.join(root, 'to'), 'made'); const from = path.join(root, 'from');
    change([{ op: 'move', from, to }]); jest.spyOn(asyncFs, 'rename').mockResolvedValueOnce(undefined);
    expect(await undoLast(state, root, realBin()).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(to, 'utf8')).toBe('made'); expect(fs.existsSync(from)).toBe(false); expect(lastUndoable(state)?.id).toBe('change');
    jest.restoreAllMocks(); jest.spyOn(os, 'homedir').mockReturnValue(path.dirname(binRoot));
    await undoLast(state, root, realBin()); expect(fs.readFileSync(from, 'utf8')).toBe('made'); expect(lastUndoable(state)).toBeNull();
  });

  it('rejects a changing backup during preflight before another step reaches the Bin', async () => {
    const target = put(path.join(root, 'target'), 'after'); const created = put(path.join(root, 'created'), 'kept'); const saved = backup();
    change([{ op: 'restore', path: target, backup: saved }, { op: 'create', path: created }]);
    const open = asyncFs.open; let changed = false;
    jest.spyOn(asyncFs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (String(args[0]) === saved) {
        const read = handle.read.bind(handle);
        jest.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
          const result = await (read as any)(...readArgs);
          if (!changed) { changed = true; fs.appendFileSync(saved, 'grew'); }
          return result;
        });
      }
      return handle;
    });
    const bin = realBin(); expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(changed).toBe(true); expect(bin.calls).toEqual([]); expect(fs.readFileSync(created, 'utf8')).toBe('kept'); expect(fs.readFileSync(target, 'utf8')).toBe('after');
  });

  it('refuses a corrupted staged copy before moving the current version', async () => {
    const target = put(path.join(root, 'target'), 'after'); change([{ op: 'restore', path: target, backup: backup() }]);
    const copy = asyncFs.copyFile;
    jest.spyOn(asyncFs, 'copyFile').mockImplementation(async (from, to, flags) => { await copy(from, to, flags); put(String(to), 'broken'); });
    const bin = realBin(); expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]); expect(fs.readFileSync(target, 'utf8')).toBe('after'); expect(fs.readdirSync(root)).toEqual(['target']);
  });

  it('does not accept a rename callback that only copies the item', async () => {
    const to = put(path.join(root, 'to'), 'made'); const from = path.join(root, 'from'); change([{ op: 'move', from, to }]);
    jest.spyOn(asyncFs, 'rename').mockImplementation(async (old, dest) => { fs.copyFileSync(String(old), String(dest)); });
    expect(await undoLast(state, root, realBin()).catch(error => error)).toBeInstanceOf(Error);
    expect(fs.readFileSync(to, 'utf8')).toBe('made'); expect(fs.readFileSync(from, 'utf8')).toBe('made'); expect(lastUndoable(state)?.id).toBe('change');
  });

  it('rejects backup leaf links even when their referent is inside the saved-copy folder', async () => {
    const target = put(path.join(root, 'target'), 'after'); const saved = backup('actual'); const link = path.join(path.dirname(saved), 'link');
    fs.symlinkSync(saved, link); change([{ op: 'restore', path: target, backup: link }]); const bin = realBin();
    expect(await undoLast(state, root, bin).catch(error => error)).toBeInstanceOf(Error);
    expect(bin.calls).toEqual([]); expect(fs.readFileSync(target, 'utf8')).toBe('after'); expect(lastUndoable(state)?.id).toBe('change');
  });
});
