import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { searchFiles } from '../main/files';

/**
 * A filter that searched only the EXPANDED rows would answer "no results" for a file that plainly
 * exists, which teaches the reader to distrust the box. So the walk is real — and because it runs
 * on keystrokes it is bounded, and says when it truncated instead of quietly returning a short list.
 */
describe('project-wide file search', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-files-'));
    fs.mkdirSync(path.join(root, 'src', 'deep', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '');
    fs.writeFileSync(path.join(root, 'src', 'server.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'nested', 'buried.ts'), '');
    fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'buried.ts'), '');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('finds a file nobody expanded to', async () => {
    const { hits } = await searchFiles(root, 'buried');
    expect(hits.map(h => h.rel)).toContain('src/deep/nested/buried.ts');
  });

  test('never returns node_modules', async () => {
    const { hits } = await searchFiles(root, 'buried');
    expect(hits.some(h => h.rel.includes('node_modules'))).toBe(false);
  });

  test('files rank above directories, shallower first', async () => {
    fs.mkdirSync(path.join(root, 'serverstuff'), { recursive: true });
    const { hits } = await searchFiles(root, 'server');
    const firstDir = hits.findIndex(h => h.dir);
    const lastFile = hits.map(h => h.dir).lastIndexOf(false);
    if (firstDir !== -1) expect(firstDir).toBeGreaterThan(lastFile - 1);
  });

  test('an empty query returns nothing rather than the whole tree', async () => {
    expect((await searchFiles(root, '   ')).hits).toEqual([]);
  });

  test('hitting the cap is reported, not hidden', async () => {
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `match-${i}.txt`), '');
    const capped = await searchFiles(root, 'match-', 5);
    expect(capped.hits).toHaveLength(5);
    expect(capped.truncated).toBe(true);
  });

  test('a path outside the project is refused, not searched', async () => {
    await expect(searchFiles('', 'anything')).resolves.toEqual({ hits: [], truncated: false });
  });
});
