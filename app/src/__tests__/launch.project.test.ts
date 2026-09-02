import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickInitialProject } from '../main/settings';

/**
 * Launch must not silently resume yesterday's repository.
 *
 * A coding session is scoped to a project, and reopening the last one means the app starts in a
 * repository the user never chose in this session — with no moment at which they chose it, and no
 * route to the picker except closing a project they did not ask to open.
 */
describe('what opens on launch', () => {
  let dir: string;
  const savedEnv = process.env.BIMAX_CWD;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-proj-'));
    delete process.env.BIMAX_CWD;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BIMAX_CWD; else process.env.BIMAX_CWD = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the last project is NOT reopened — the user is asked instead', () => {
    expect(pickInitialProject(dir)).toBeNull();
  });

  test('an explicit BIMAX_CWD still opens that project', () => {
    expect(pickInitialProject(undefined, dir)).toBe(path.resolve(dir));
  });

  test('an explicit instruction beats a saved project', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-other-'));
    try {
      expect(pickInitialProject(dir, other)).toBe(path.resolve(other));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('a nonexistent explicit path opens nothing rather than booting somewhere wrong', () => {
    expect(pickInitialProject(undefined, path.join(dir, 'gone'))).toBeNull();
  });
});
