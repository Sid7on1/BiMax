import * as fs from 'fs';
import * as path from 'path';

/**
 * The retrieval suites live in TWO files' opinions: jest.config.ts excludes them, package.json's
 * `test:bun` runs them under bun. Nothing enforced that those two lists agree, and a suite
 * that falls out of both is a suite nobody runs — green the way an unread file is green. That has
 * already happened here three times with packaging.sidecar.test.ts, so this pins it.
 */
const REPO = path.join(__dirname, '..', '..');
const jestConfig = fs.readFileSync(path.join(REPO, 'jest.config.ts'), 'utf8');
const scripts = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts as Record<string, string>;

const excluded = [...jestConfig.matchAll(/'<rootDir>\/(src\/__tests__\/[^']+)'/g)].map((m) => m[1]!);

describe('the suites jest cannot run are run somewhere else', () => {
  it('excludes at least the retrieval suites, and every one of them still exists', () => {
    expect(excluded.length).toBeGreaterThan(0);
    for (const suite of excluded) {
      expect(fs.existsSync(path.join(REPO, suite))).toBe(true);
    }
  });

  it('every excluded suite is in test:bun, and test:bun is in test', () => {
    const retrieval = scripts['test:bun'] ?? '';
    for (const suite of excluded) {
      expect(retrieval).toContain(suite);
    }
    // The default command must still reach them, or excluding them is just hiding them.
    expect(scripts.test).toContain('test:bun');
    expect(scripts['test:ci']).toContain('test:bun');
  });

  it('is still necessary — this runtime really cannot do FTS5', () => {
    // A self-retiring guard. If Node ever ships FTS5 in node:sqlite, this fails and says to move
    // the suites back into the normal run instead of leaving the workaround in place forever.
    let hasFts5 = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
      hasFts5 = true;
    } catch { /* the expected case: no FTS5 under plain Node */ }
    expect(hasFts5).toBe(false);
  });
});
