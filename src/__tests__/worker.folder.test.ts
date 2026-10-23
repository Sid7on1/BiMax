import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { engineWorkerRoot, installWorkerFolder, type WorkerFolderModules } from '../engine/worker.folder';

/**
 * Record 64, M1: an engine running as a worker thread gets a working folder of its own. Installed here on COPIES of
 * the real modules, so the test process's own fs and cwd are never touched; the real install happens only inside an
 * engine worker (`engineWorkerRoot`).
 */

let root: string;
let scratchCwd: string;
let realCwd: string;
let m: WorkerFolderModules & { fs: typeof fs & { promises: typeof fs.promises }; childProcess: typeof childProcess };

// The test process itself works from a scratch folder while these run: if the code under test ever fails to resolve
// a relative path, the stray file lands there — never in the repository (a mutant run once left a.txt in the repo root).
beforeAll(() => {
  realCwd = process.cwd();
  scratchCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-worker-folder-cwd-')));
  process.chdir(scratchCwd);
});
afterAll(() => {
  process.chdir(realCwd);
  fs.rmSync(scratchCwd, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-worker-folder-')));
  fs.mkdirSync(path.join(root, 'sub'));
  m = {
    process: { cwd: () => '/', chdir: () => undefined },
    fs: { ...fs, promises: { ...fs.promises } },
    childProcess: { ...childProcess },
  } as never;
  installWorkerFolder(root, m);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('the worker reports its own folder, and the real process is untouched', () => {
  expect(m.process.cwd()).toBe(root);
  expect(process.cwd()).toBe(scratchCwd);
});

test('relative reads and writes land in the worker\'s folder', async () => {
  m.fs.writeFileSync('a.txt', 'one');
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(fs.existsSync(path.join(scratchCwd, 'a.txt'))).toBe(false);
  expect(m.fs.readFileSync('a.txt', 'utf8')).toBe('one');
  await m.fs.promises.writeFile('b.txt', 'two');
  expect(await m.fs.promises.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('two');
  m.fs.renameSync('b.txt', 'sub/c.txt');
  expect(fs.readFileSync(path.join(root, 'sub', 'c.txt'), 'utf8')).toBe('two');
  expect(m.fs.readdirSync('.').sort()).toEqual(['a.txt', 'sub']);
  expect(m.fs.realpathSync.native('a.txt')).toBe(path.join(root, 'a.txt'));
});

test('absolute paths pass through unchanged', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-worker-folder-abs-'));
  try {
    m.fs.writeFileSync(path.join(elsewhere, 'x.txt'), 'x');
    expect(fs.readFileSync(path.join(elsewhere, 'x.txt'), 'utf8')).toBe('x');
  } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

test('chdir moves the folder, and fails the way the real one does', () => {
  m.process.chdir('sub');
  expect(m.process.cwd()).toBe(path.join(root, 'sub'));
  m.fs.writeFileSync('in-sub.txt', 'y');
  expect(fs.existsSync(path.join(root, 'sub', 'in-sub.txt'))).toBe(true);
  m.process.chdir('..');
  expect(() => m.process.chdir('missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  m.fs.writeFileSync('file.txt', 'z');
  expect(() => m.process.chdir('file.txt')).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  expect(m.process.cwd()).toBe(root);
});

test('a symlink\'s target stays as written; only the link path is resolved', () => {
  m.fs.writeFileSync('target.txt', 't');
  m.fs.symlinkSync('target.txt', 'link.txt');
  expect(fs.readlinkSync(path.join(root, 'link.txt'))).toBe('target.txt');
  expect(fs.readFileSync(path.join(root, 'link.txt'), 'utf8')).toBe('t');
});

test('file-descriptor calls are untouched', () => {
  const fd = m.fs.openSync('fd.txt', 'w');
  m.fs.writeSync(fd, 'by fd');
  m.fs.closeSync(fd);
  expect(fs.readFileSync(path.join(root, 'fd.txt'), 'utf8')).toBe('by fd');
});

test('child processes that name no folder start in the worker\'s; one that names a folder keeps it', () => {
  expect(m.childProcess.execFileSync('pwd').toString().trim()).toBe(root);
  expect(m.childProcess.execFileSync('pwd', []).toString().trim()).toBe(root);
  expect(m.childProcess.execSync('pwd').toString().trim()).toBe(root);
  expect(m.childProcess.spawnSync('pwd').stdout.toString().trim()).toBe(root);
  expect(m.childProcess.spawnSync('pwd', [], { encoding: 'utf8' }).stdout.trim()).toBe(root);
  expect(m.childProcess.execFileSync('pwd', { cwd: path.join(root, 'sub') }).toString().trim()).toBe(path.join(root, 'sub'));
});

test('promisify keeps the custom forms of exec and exists', async () => {
  const run = await promisify(m.childProcess.exec)('pwd');
  expect(run).toEqual({ stdout: `${root}\n`, stderr: '' });
  m.fs.writeFileSync('here.txt', 'h');
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  await expect(promisify(m.fs.exists)('here.txt')).resolves.toBe(true);
});

test('glob searches the worker\'s folder', () => {
  if (typeof (fs as unknown as { globSync?: unknown }).globSync !== 'function') return; // Node without fs.glob
  m.fs.writeFileSync('g1.md', '1');
  m.fs.writeFileSync('sub/g2.md', '2');
  const found = (m.fs as unknown as { globSync: (p: string) => string[] }).globSync('**/*.md').sort();
  expect(found).toEqual(['g1.md', path.join('sub', 'g2.md')]);
});

test('outside an engine worker nothing is installed', () => {
  expect(engineWorkerRoot()).toBeNull();
});
