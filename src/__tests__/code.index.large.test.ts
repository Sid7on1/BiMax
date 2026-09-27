import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodeIndex } from '../memory/code.index';

/**
 * Big projects get code search. They used to get none: past 12,000 "source" files the index was
 * skipped outright, and the count was inflated by generated trees `.gitignore` already excludes.
 *
 * Needs SQLite FTS5, which Bun has and this Mac's Node 22 does not: run with `bun test`.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-codeidx-large-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, text: string, mtimeSecondsAgo = 0): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  if (mtimeSecondsAgo) {
    const t = new Date(Date.now() - mtimeSecondsAgo * 1000);
    fs.utimesSync(abs, t, t);
  }
}

const index = (maxFiles?: number) => new CodeIndex(null, null, {
  root: tmp,
  storePath: path.join(tmp, '.state', 'code-index.db'),
  sliceBudgetMs: 0,
  ...(maxFiles !== undefined ? { maxFiles } : {}),
});

test('in a git project, files .gitignore excludes are not indexed; untracked source still is', async () => {
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  write('.gitignore', 'generated/\n.state/\n');
  write('src/app.ts', 'export function rotateKeys() { return 1; }\n');
  write('src/new.ts', 'export function freshlyAdded() { return 2; }\n'); // untracked, not ignored
  write('generated/huge.ts', 'export function generatedNoise() { return 3; }\n');
  execFileSync('git', ['add', 'src/app.ts', '.gitignore'], { cwd: tmp });

  const idx = index();
  const result = await idx.sync(100);
  expect(result.indexed).toBe(2);
  expect((await idx.search('generatedNoise', 5)).map((h) => h.path)).not.toContain('generated/huge.ts');
  expect((await idx.search('freshlyAdded', 5)).map((h) => h.path)).toContain('src/new.ts');
});

test('a project over the ceiling indexes its most recently changed files and says coverage is partial', async () => {
  for (let i = 0; i < 5; i++) write(`src/f${i}.ts`, `export function fn${i}() { return ${i}; }\n`, (5 - i) * 100);
  const idx = index(3);
  const result = await idx.sync(100);
  expect(result.indexed).toBe(3);
  expect(idx.coverage().partial).toEqual({ indexed: 3, total: 5 });
  // f2, f3, f4 are the newest.
  expect((await idx.search('fn4', 5)).map((h) => h.path)).toContain('src/f4.ts');
  expect((await idx.search('fn0', 5)).map((h) => h.path)).not.toContain('src/f0.ts');
});

test('a project under the ceiling reports full coverage', async () => {
  write('src/a.ts', 'export const a = 1;\n');
  const idx = index(3);
  await idx.sync(100);
  expect(idx.coverage().partial).toBeNull();
});

test('coverage returns to full once the project shrinks back under the ceiling', async () => {
  for (let i = 0; i < 4; i++) write(`src/f${i}.ts`, `export const v${i} = ${i};\n`, (4 - i) * 100);
  const idx = index(3);
  await idx.sync(100);
  expect(idx.coverage().partial).toEqual({ indexed: 3, total: 4 });
  fs.rmSync(path.join(tmp, 'src', 'f0.ts'));
  await idx.sync(100);
  expect(idx.coverage().partial).toBeNull();
});
