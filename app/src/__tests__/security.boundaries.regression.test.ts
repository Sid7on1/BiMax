import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isAllowedNavigation, isTrustedSender } from '../main/security';
import { ProjectFiles } from '../main/project.files';
import { listDir, readFilePreview, writeFileContent, searchFiles, readSessionMeta } from '../main/files';

test('F01 exact packaged document identity is required even for the correct main sender', () => {
  const own = 'file:///Applications/Bimax.app/Contents/Resources/app.asar/out/renderer/index.html';
  const trusted = { webContentsId: 7, packagedRendererUrls: [own] };
  for (const url of ['file:///tmp/foreign.html', own + '-foreign', 'data:text/html,test', 'https://foreign.invalid/']) {
    expect(isAllowedNavigation(url, trusted)).toBe(false);
    expect(isTrustedSender({ senderId: 7, frameUrl: url, isMainFrame: true }, trusted)).toBe(false);
  }
  expect(isAllowedNavigation(own + '?surface=quick#task', trusted)).toBe(true);
  expect(isTrustedSender({ senderId: 7, frameUrl: own, isMainFrame: true }, trusted)).toBe(true);
  expect(isTrustedSender({ senderId: 7, frameUrl: own, isMainFrame: false }, trusted)).toBe(false);
  expect(isAllowedNavigation(own, { webContentsId: 7 })).toBe(false);
});
test('F01 development URL matching parses origin and document, never a string prefix', () => {
  const trusted = { webContentsId: 7, devServerUrl: 'http://localhost:5173/' };
  expect(isAllowedNavigation('http://localhost:5173/?surface=quick', trusted)).toBe(true);
  expect(isAllowedNavigation('http://localhost:5173/index.html', trusted)).toBe(true);
  for (const url of [
    'http://localhost:5173@foreign.invalid/',
    'http://localhost:51730/',
    'http://localhost:5173/foreign.html',
    'file:///tmp/foreign.html',
  ])
    expect(isAllowedNavigation(url, trusted)).toBe(false);
});

describe('F02 descriptor-bound project files', () => {
  let dir: string, root: string, outside: string, files: ProjectFiles;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-file-authority-'));
    root = path.join(dir, 'project');
    outside = path.join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'bystander');
    files = new ProjectFiles(root);
  });
  afterEach(async () => {
    await files.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  test('reads/writes/list remain usable; linked outside reads/writes/list are refused without changing bystanders', async () => {
    await writeFileContent(files, 'inside', 'α👋');
    expect(await readFilePreview(files, 'inside')).toMatchObject({ content: 'α👋', binary: false, truncated: false });
    expect(await listDir(files, '.')).toEqual([{ name: 'inside', dir: false }]);
    await fs.symlink(outside, path.join(root, 'escape'));
    await expect(readFilePreview(files, 'escape/sentinel')).rejects.toThrow();
    await expect(writeFileContent(files, 'escape/sentinel', 'bad')).rejects.toThrow();
    await expect(listDir(files, 'escape')).rejects.toThrow();
    await fs.symlink(path.join(outside, 'sentinel'), path.join(root, 'leaf'));
    await expect(writeFileContent(files, 'leaf', 'bad')).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('bystander');
    expect((await searchFiles(files, 'sentinel')).hits).toEqual([]);
  });
  test('root-path replacement cannot redirect an already selected project; retired objects cannot act', async () => {
    await writeFileContent(files, 'inside', 'original');
    await fs.rename(root, root + '-moved');
    await fs.symlink(outside, root);
    expect((await readFilePreview(files, 'inside')).content).toBe('original');
    await files.close();
    await expect(writeFileContent(files, 'sentinel', 'bad')).rejects.toThrow('retired');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('bystander');
  });
  test('hardlinks, devices, oversized writes and traversal refuse before changing bytes', async () => {
    await fs.link(path.join(outside, 'sentinel'), path.join(root, 'hardlink'));
    execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe')]);
    await expect(readFilePreview(files, 'pipe')).rejects.toThrow();
    await expect(writeFileContent(files, 'pipe', 'bad')).rejects.toThrow();
    await expect(writeFileContent(files, 'hardlink', 'bad')).rejects.toThrow();
    await expect(readFilePreview(files, '..')).rejects.toThrow();
    await expect(writeFileContent(files, '../outside/sentinel', 'bad')).rejects.toThrow();
    await expect(writeFileContent(files, 'new', 'α'.repeat(5 * 1024 * 1024))).rejects.toThrow('byte budget');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('bystander');
  });
  test('bounded read reports real file size and preserves binary detection', async () => {
    await fs.writeFile(path.join(root, 'large'), Buffer.alloc(600_000, 65));
    expect(await readFilePreview(files, 'large')).toMatchObject({ size: 600_000, truncated: true });
    await fs.writeFile(path.join(root, 'binary'), Buffer.from([65, 0, 66]));
    expect(await readFilePreview(files, 'binary')).toMatchObject({ content: '', binary: true });
  });
});

test('F02 bounded session metadata retains the newest records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-meta-tail-'));
  try {
    await fs.mkdir(path.join(root, '.breakglass/sessions'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.breakglass/sessions/sessions-meta.jsonl'),
      JSON.stringify({ id: 'old', title: 'x'.repeat(600000) }) +
        '\n' +
        JSON.stringify({ id: 'new', title: 'latest' }) +
        '\n',
    );
    expect(await readSessionMeta(root)).toMatchObject([{ id: 'new', title: 'latest' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('F02 child-process I/O budget is shared across retired or switched projects', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-file-budget-'));
  const helper = path.join(directory, 'hold.sh');
  await fs.writeFile(helper, '#!/bin/sh\nexec /bin/sleep 0.2\n', { mode: 0o700 });
  const first = new ProjectFiles(directory, helper),
    second = new ProjectFiles(directory, helper);
  const held = Promise.allSettled(Array.from({ length: 8 }, () => first.readFilePreview('inside')));
  const retired = first.close();
  try {
    await expect(second.readFilePreview('inside')).rejects.toThrow('busy');
    await held;
    await retired;
    // The old children released their shared slots; only the synthetic helper's invalid response remains.
    await expect(second.readFilePreview('inside')).rejects.toThrow('Invalid file response');
  } finally {
    await held;
    await first.close();
    await second.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
