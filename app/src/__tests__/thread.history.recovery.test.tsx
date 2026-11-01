import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThreadStorage, THREAD_SNAPSHOT_MAX_BYTES, THREAD_RECOVERY_MAX_BYTES } from '../main/thread.storage';
import { ThreadBinRecovery } from '../main/thread.bin.recovery';
import { recoveryExportAction } from '../main/thread.recovery.export';
import { ThreadRecoveryList } from '../renderer/src/components/ThreadRecoveryList';
import { initialEngineState } from '../renderer/src/engine.state';

let root: string, dir: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-history-recovery-')); dir = path.join(root, 'threads'); fs.mkdirSync(dir); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function unreadable(archived = false, id = 'kept') {
  const folder = archived ? path.join(dir, 'archive') : dir; fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.json`); fs.writeFileSync(file, 'Original\nUTF-8: 界\0\xff not valid JSON');
  return file;
}

test.each([false, true])('the production recovery action exports exact retained bytes (archived=%s), preserving originals', async archived => {
  const source = unreadable(archived); const bytes = fs.readFileSync(source);
  const store = new ThreadStorage(dir); store.load(); if (archived) await store.archived();
  const target = path.join(root, 'export.json'); fs.writeFileSync(target, 'old chosen export');
  const choose = jest.fn(async () => target);
  expect(await recoveryExportAction(store, choose)('kept', archived)).toEqual({ ok: true });
  expect(choose).toHaveBeenCalledWith('kept');
  expect(sha(fs.readFileSync(target))).toBe(sha(bytes));
  expect(fs.readFileSync(source)).toEqual(bytes);
  expect(fs.statSync(target).mode & 0o777).toBe(0o600);
});

test('invalid/uncatalogued identities never open the picker; cancellation exports nothing', async () => {
  unreadable(); const store = new ThreadStorage(dir); store.load();
  const choose = jest.fn(async () => null); const act = recoveryExportAction(store, choose);
  for (const [id, archived, backup] of [['../escape', false, false], ['unknown', false, false], ['kept', 'yes', false], ['kept', true, true]])
    expect(await act(id, archived, backup)).toMatchObject({ ok: false });
  expect(choose).not.toHaveBeenCalled();
  expect(await act('kept', false)).toEqual({ ok: false, cancelled: true });
  expect(fs.readdirSync(root)).toEqual(['threads']);
});

test('export cannot replace any conversation inside storage, including through a directory alias', async () => {
  const source = unreadable(), original = fs.readFileSync(source);
  const store = new ThreadStorage(dir); store.load();
  fs.symlinkSync(dir, path.join(root, 'alias'));
  const action = recoveryExportAction(store, async () => path.join(root, 'alias', 'kept.json'));
  expect(await action('kept', false)).toMatchObject({ ok: false, error: expect.stringContaining('outside') });
  expect(fs.readFileSync(source)).toEqual(original);
});

test('a replaced symlink source is refused without following it or changing the chosen destination', async () => {
  const source = unreadable(); const store = new ThreadStorage(dir); store.load();
  const external = path.join(root, 'private.txt'); fs.writeFileSync(external, 'external sentinel');
  fs.unlinkSync(source); fs.symlinkSync(external, source);
  const target = path.join(root, 'export.json'); fs.writeFileSync(target, 'destination sentinel');
  expect(await recoveryExportAction(store, async () => target)('kept', false)).toMatchObject({ ok: false });
  expect(fs.readFileSync(target, 'utf8')).toBe('destination sentinel');
  expect(fs.readFileSync(external, 'utf8')).toBe('external sentinel');
});

test('source replacement during the streamed export refuses publication and cleans the temporary copy', async () => {
  const source = unreadable(); const store = new ThreadStorage(dir); store.load();
  const target = path.join(root, 'export.json'); fs.writeFileSync(target, 'destination sentinel');
  const realOpen = fsp.open.bind(fsp);
  const open = jest.spyOn(fsp, 'open').mockImplementation(async (...args: any[]) => {
    const handle = await (realOpen as any)(...args);
    if (args[0] === source) {
      fs.renameSync(source, `${source}.prior`); fs.writeFileSync(source, 'replacement sentinel');
    }
    return handle;
  });
  expect(await recoveryExportAction(store, async () => target)('kept', false)).toMatchObject({ ok: false, error: expect.stringContaining('changed') });
  open.mockRestore();
  expect(fs.readFileSync(target, 'utf8')).toBe('destination sentinel');
  expect(fs.readFileSync(source, 'utf8')).toBe('replacement sentinel');
  expect(fs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([]);
});

test('exact-limit snapshots survive the Bin envelope and restore exact content after reopening recovery', async () => {
  const value = { summary: { id: 'limit', root: '/fixture', title: 'Limit conversation', status: 'stopped', updatedAt: 1, peers: [] },
    state: { ...initialEngineState, items: [{ kind: 'msg', msg: { id: 'msg', role: 'assistant', content: '', timestamp: '2026-10-31T00:00:00Z' } }] }, inputs: [] };
  const size = Buffer.byteLength(JSON.stringify(value));
  value.state.items[0].msg.content = 'x'.repeat(THREAD_SNAPSHOT_MAX_BYTES - size);
  fs.writeFileSync(path.join(dir, 'limit.json'), JSON.stringify(value));
  const bin = { moveToBin: async (file: string) => { fs.unlinkSync(file); return null; } };
  const recovery = new ThreadBinRecovery(dir, bin, () => 1);
  await expect(recovery.move('limit', false)).resolves.toBeUndefined();
  expect(fs.statSync(path.join(dir, '.bin-recovery', 'limit.json')).size).toBeGreaterThan(THREAD_SNAPSHOT_MAX_BYTES);
  expect(fs.statSync(path.join(dir, '.bin-recovery', 'limit.json')).size).toBeLessThanOrEqual(THREAD_RECOVERY_MAX_BYTES);
  const reopened = new ThreadBinRecovery(dir, bin, () => 1);
  expect(reopened.latest()?.id).toBe('limit');
  expect(reopened.undo('limit').value.state.items).toEqual(value.state.items);
  expect(new ThreadStorage(dir).load()[0].state.items).toEqual(value.state.items);
});

test('oversized and corrupt Bin backups survive pruning and have exact-byte recovery export', async () => {
  const folder = path.join(dir, '.bin-recovery'); fs.mkdirSync(folder);
  const corrupt = path.join(folder, 'corrupt.json'); fs.writeFileSync(corrupt, 'retained corrupt backup');
  const big = path.join(folder, 'big.json'); fs.writeFileSync(big, 'retained oversized backup'); fs.truncateSync(big, THREAD_RECOVERY_MAX_BYTES + 1);
  const store = new ThreadStorage(dir);
  const recovery = new ThreadBinRecovery(dir, { moveToBin: async () => null }, () => 10, id => store.noteRecoveryBackup(id));
  recovery.prune(); store.load();
  expect(fs.existsSync(corrupt)).toBe(true);
  expect(fs.existsSync(big)).toBe(true);
  expect(fs.readFileSync(corrupt, 'utf8')).toBe('retained corrupt backup');
  expect(fs.statSync(big).size).toBe(THREAD_RECOVERY_MAX_BYTES + 1);
  expect(store.recoverable()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'corrupt', backup: true, reason: 'unreadable' }),
    expect.objectContaining({ id: 'big', backup: true, reason: 'oversized' }),
  ]));
  const destination = path.join(root, 'backup.json');
  expect(await recoveryExportAction(store, async () => destination)('big', false, true)).toEqual({ ok: true });
  expect(sha(fs.readFileSync(destination))).toBe(sha(fs.readFileSync(big)));
});

test('independent read-back catches corrupted staged bytes without replacing an earlier export', async () => {
  unreadable(); const store = new ThreadStorage(dir); store.load();
  const target = path.join(root, 'export.json'); fs.writeFileSync(target, 'earlier export');
  const realOpen = fsp.open.bind(fsp);
  jest.spyOn(fsp, 'open').mockImplementation(async (...args: any[]) => {
    const handle = await (realOpen as any)(...args);
    if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
      const write = handle.write.bind(handle);
      handle.write = (buffer: Buffer, offset: number, length: number, position: number) => {
        const wrong = Buffer.from(buffer); wrong[offset] ^= 1;
        return write(wrong, offset, length, position);
      };
    }
    return handle;
  });
  expect(await recoveryExportAction(store, async () => target)('kept', false)).toMatchObject({ ok: false, error: expect.stringContaining('verification') });
  expect(fs.readFileSync(target, 'utf8')).toBe('earlier export');
  expect(fs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([]);
});

test('actual recovery presentation identifies saved/archive/backup sources and exposes export, without resume/delete actions', () => {
  const html = renderToStaticMarkup(<ThreadRecoveryList entries={[
    { id: 'saved', archived: false, bytes: 40_000_000, reason: 'oversized' },
    { id: 'archive', archived: true, bytes: 12, reason: 'unreadable' },
    { id: 'backup', archived: false, backup: true, bytes: 12, reason: 'unreadable' },
  ]} exportCopy={async () => ({ ok: true })} />);
  expect(html).toContain('Conversation recovery');
  expect(html).toContain('Too large to open safely');
  expect(html).toContain('Archived conversation');
  expect(html).toContain('Conversation recovery backup');
  expect(html.match(/Export recovery copy/g)).toHaveLength(3);
  expect(html).not.toMatch(/Resume|Move to the Bin/);
});
