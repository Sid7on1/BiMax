import fs = require('fs/promises');
import * as syncFs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { journalDir, recordBeforeChange } from '../tools/thread.journal';
import { ChangePlan } from '../tools/thread.changes';
import { changeHistory, undoLast } from '../../app/src/main/thread.undo';

describe('Bimax Thread journal sprint — missing protection is explicit', () => {
  let dir: string;
  let env: { root?: string; state?: string };
  beforeEach(async () => {
    env = { root: process.env.BIMAX_THREAD_ROOT, state: process.env.BIMAX_STATE_DIR };
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-journal-sprint-'));
    process.env.BIMAX_THREAD_ROOT = dir;
    process.env.BIMAX_STATE_DIR = path.join(dir, 'state');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (env.root === undefined) delete process.env.BIMAX_THREAD_ROOT; else process.env.BIMAX_THREAD_ROOT = env.root;
    if (env.state === undefined) delete process.env.BIMAX_STATE_DIR; else process.env.BIMAX_STATE_DIR = env.state;
    await fs.rm(dir, { force: true, recursive: true });
  });
  const plan = (target: string): ChangePlan => ({ kind: 'write', title: 'Replace file', preview: [], undoable: true, moves: [], trash: [], creates: [], overwrites: [target] });

  it('records an unprotected overwrite instead of silently omitting a failed backup', async () => {
    const target = path.join(dir, 'target'); await fs.writeFile(target, 'before');
    jest.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('injected disk failure'));
    const entry = await recordBeforeChange(plan(target), 'WriteFileTool');
    expect(entry).not.toBeNull();
    expect(entry?.ops).toEqual([expect.objectContaining({ op: 'unprotected', path: target, reason: expect.stringContaining('injected disk failure') })]);
    expect(syncFs.readFileSync(path.join(journalDir(), 'journal.jsonl'), 'utf8')).toContain('unprotected');
    expect(await fs.readFile(target, 'utf8')).toBe('before');
  });

  it('keeps complete coverage when one overwrite is protected and another is too large', async () => {
    const regular = path.join(dir, 'regular'); const huge = path.join(dir, 'huge');
    await fs.writeFile(regular, 'before'); await fs.writeFile(huge, ''); await fs.truncate(huge, 512 * 1024 * 1024 + 1);
    const entry = await recordBeforeChange({ ...plan(regular), overwrites: [regular, huge] }, 'WriteFileTool');
    expect(entry?.ops).toEqual([expect.objectContaining({ op: 'restore', path: regular }), expect.objectContaining({ op: 'unprotected', path: huge })]);
    expect(changeHistory(process.env.BIMAX_STATE_DIR!)[0]?.reversibility).toBe('partial');
    const moveToBin = jest.fn();
    expect(await undoLast(process.env.BIMAX_STATE_DIR!, dir, { moveToBin, restoreFromBin: jest.fn() }).catch(error => error)).toBeInstanceOf(Error);
    expect(moveToBin).not.toHaveBeenCalled(); expect(await fs.readFile(regular, 'utf8')).toBe('before');
  });

  it('marks symlink and directory replacements unprotected while leaving their contents untouched', async () => {
    const target = path.join(dir, 'target'); const link = path.join(dir, 'link'); const folder = path.join(dir, 'folder');
    await fs.writeFile(target, 'kept'); await fs.symlink(target, link); await fs.mkdir(folder);
    const entry = await recordBeforeChange({ ...plan(link), overwrites: [link, folder] }, 'WriteFileTool');
    expect(entry?.ops).toEqual([expect.objectContaining({ op: 'unprotected', path: link }), expect.objectContaining({ op: 'unprotected', path: folder })]);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true); expect(await fs.readFile(target, 'utf8')).toBe('kept');
  });

  it('round-trips a real engine journal through app undo including empty-file permissions', async () => {
    const target = path.join(dir, 'target'); await fs.writeFile(target, ''); await fs.chmod(target, 0o750);
    const entry = await recordBeforeChange(plan(target), 'WriteFileTool');
    expect(entry?.ops[0]?.op).toBe('restore'); await fs.writeFile(target, 'after');
    const binned = path.join(dir, 'current-version');
    await undoLast(process.env.BIMAX_STATE_DIR!, dir, { async moveToBin(p) { await fs.rename(p, binned); return null; }, restoreFromBin: jest.fn() });
    expect(await fs.readFile(target)).toEqual(Buffer.alloc(0)); expect((await fs.stat(target)).mode & 0o777).toBe(0o750);
    expect(await fs.readFile(binned, 'utf8')).toBe('after'); expect(changeHistory(process.env.BIMAX_STATE_DIR!)).toEqual([]);
  });
});
