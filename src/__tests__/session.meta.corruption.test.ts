import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A torn line in the append-only session log must cost exactly that line.
 *
 * Regression: readAllMeta() parsed the whole file under one try/catch and returned [] on any
 * failure. A single interrupted write therefore (a) blanked Recents to "Nothing yet" and
 * (b) made updateMeta's findIndex miss every id, so recordFirstUserMessage stopped writing
 * titles and every subsequent session stayed "(no messages yet)".
 */
describe('session meta survives a damaged line', () => {
  let dir: string;
  let cwd: string;
  let meta: typeof import('../db/session.meta');

  const write = (lines: string[]): void => {
    const p = path.join(dir, '.breakglass', 'sessions', 'sessions-meta.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  };
  const row = (id: string, title = '(no messages yet)'): string =>
    JSON.stringify({ id, title, cwd: dir, startedAt: '2026-09-02T00:00:00.000Z', messageCount: 0, tokenEstimate: 0 });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-meta-'));
    cwd = process.cwd();
    process.chdir(dir);
    jest.resetModules();
    meta = require('../db/session.meta');
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the intact rows still list when one line is torn', () => {
    write([row('a'), 'enEstimate":0}', row('b'), row('c')]);
    expect(meta.listSessionMeta(20).map(m => m.id)).toEqual(['c', 'b', 'a']);
  });

  test('a title still lands after a torn line (the Recents/"no messages yet" bug)', () => {
    write([row('a'), '{"id":"torn","tit', row('b')]);
    meta.startSessionMeta('live', dir);
    expect(meta.recordFirstUserMessage('build the socket server')).toBe(true);

    jest.resetModules();
    const reread = require('../db/session.meta') as typeof import('../db/session.meta');
    const found = reread.listSessionMeta(20).find(m => m.id === 'live');
    expect(found?.title).toBe('build the socket server');
    // the undamaged neighbours are still there
    expect(reread.listSessionMeta(20).map(m => m.id)).toEqual(expect.arrayContaining(['a', 'b', 'live']));
  });

  test('resume reuses the existing record rather than duplicating it', () => {
    write([row('a'), 'garbage', row('keep', 'earlier thread')]);
    meta.resumeSessionMeta('keep');
    jest.resetModules();
    const reread = require('../db/session.meta') as typeof import('../db/session.meta');
    expect(reread.listSessionMeta(20).filter(m => m.id === 'keep')).toHaveLength(1);
  });

  test('a missing file is still an empty history, not an error', () => {
    expect(meta.listSessionMeta(20)).toEqual([]);
  });
});
