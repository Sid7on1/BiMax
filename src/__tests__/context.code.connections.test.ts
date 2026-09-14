import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeIndex, importedFiles } from '../memory/code.index';
import { createCodeSearchTool } from '../tools/implementations/code.search.tool';
import { openSqlite } from '../core/sqlite';

/**
 * Record 50 step 7: code search follows imports. A behaviour question rarely names the helper, the contract or the test
 * a change needs; the files the results import, and the files that import them, are listed with the results
 * (benchmark M1, M2, held-out H3, H4).
 */

const governor = { approveTaskExecution: async () => {} } as any;

function sqliteHasFts5(): boolean {
  const db = openSqlite(':memory:');
  if (!db) return false;
  try {
    db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

let temp: string;
beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-code-connections-')); });
afterAll(() => { fs.rmSync(temp, { recursive: true, force: true }); });

test('relative imports resolve to indexed files in every form; packages and unknown files are not followed', () => {
  const known = new Set([
    'src/net/retry.ts', 'src/net/cancel.ts', 'src/config/limits.ts', 'src/log/index.ts', 'src/util/esm.ts',
    'src/net/side.ts', 'src/net/lazy.ts', 'src/net/legacy.js', 'pkg/app/main.py', 'pkg/app/helpers.py', 'pkg/shared/__init__.py',
  ]);
  const source = [
    "import { CancellationToken } from './cancel';",
    "import type { Limits } from '../config/limits';",
    "export * from '../log';",
    "import { esm } from '../util/esm.js';",
    "import './side';",
    "const lazy = await import('./lazy');",
    "const legacy = require('./legacy');",
    "import fs from 'fs';",
    "import { missing } from './missing';",
  ].join('\n');
  expect(importedFiles('src/net/retry.ts', source, known)).toEqual([
    'src/config/limits.ts', 'src/log/index.ts', 'src/net/cancel.ts', 'src/net/lazy.ts', 'src/net/legacy.js', 'src/net/side.ts', 'src/util/esm.ts',
  ]);
  const python = 'from .helpers import load\nfrom .. import shared\nimport os\n';
  expect(importedFiles('pkg/app/main.py', python, known)).toEqual(['pkg/app/helpers.py', 'pkg/shared/__init__.py']);
});

(sqliteHasFts5() ? describe : describe.skip)('code search follows imports (needs SQLite FTS5: npm run test:context)', () => {
  const REPO: Record<string, string> = {
    'src/net/cancel.ts': 'export class CancellationToken { cancel(): void {} throwIfCancelled(): void {} }\n',
    'src/net/retry.ts': "import { CancellationToken } from './cancel';\nexport function retryWithBackoff(token: CancellationToken) { token.throwIfCancelled(); }\n",
    'src/net/retry.test.ts': "import { retryWithBackoff } from './retry';\nexport function retriesStop() { return retryWithBackoff; }\n",
    'src/net/client.ts': "import { retryWithBackoff } from './retry';\nexport const client = retryWithBackoff;\n",
    'src/unrelated/palette.ts': 'export const colours = ["teal", "amber"];\n',
  };
  const build = async (name: string) => {
    const root = path.join(temp, name);
    for (const [rel, text] of Object.entries(REPO)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const storePath = path.join(temp, `${name}.db`);
    const index = new CodeIndex(null, null, { root, storePath });
    await index.sync();
    return { root, storePath, index };
  };

  test('results come with the files they import and the files importing them, within two hops', async () => {
    const { root, index } = await build('connections');
    const text = String(await createCodeSearchTool(governor, index).execute({ query: 'CancellationToken cancel', limit: 1 }, { cwd: root }));
    expect(text).toContain('src/net/cancel.ts');
    const connected = text.slice(text.indexOf('Connected by imports'));
    expect(connected).toContain('- src/net/retry.ts — imports src/net/cancel.ts');
    // Two hops: the test and the client reach cancel.ts through retry.ts.
    expect(connected).toContain('- src/net/retry.test.ts — imports src/net/retry.ts');
    expect(connected).toContain('- src/net/client.ts — imports src/net/retry.ts');
    // Control: a file with no import path to the results is not listed.
    expect(connected).not.toContain('palette');
    // The limit holds even when one file has more connections than it: retry.ts imports one file and two import it.
    expect(await index.connectedFiles(['src/net/retry.ts'], 1)).toEqual([{ path: 'src/net/cancel.ts', relation: 'imported by src/net/retry.ts' }]);
  });

  test('an index written before import edges gets them at the next sync without re-indexing', async () => {
    const { root, storePath } = await build('legacy-edges');
    const manifestPath = `${storePath}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const entry of Object.values(manifest) as Array<{ i?: string[] }>) delete entry.i;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const reopened = new CodeIndex(null, null, { root, storePath });
    expect(await reopened.connectedFiles(['src/net/cancel.ts'])).toEqual([]);
    expect((await reopened.sync()).indexed).toBe(0);
    expect((await reopened.connectedFiles(['src/net/cancel.ts'])).map((c) => c.path)).toContain('src/net/retry.ts');
  });
});
