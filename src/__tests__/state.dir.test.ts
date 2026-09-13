import * as path from 'path';
import { stateDir, stateRoot } from '../utils/state.dir';

/** Engine state stays in the project unless the desktop app redirects it for a ⌘2 thread. */
afterEach(() => { delete process.env.BIMAX_STATE_DIR; });

test('state paths resolve in the project by default and under the app data folder for a thread', () => {
  expect(stateDir('.bimax', '/repo')).toBe(path.join('/repo', '.bimax'));
  expect(stateDir('.breakglass')).toBe(path.join(process.cwd(), '.breakglass'));
  process.env.BIMAX_STATE_DIR = '/app-data/thread-state/abc';
  expect(stateDir('.bimax', '/Users/me/Desktop')).toBe(path.join('/app-data/thread-state/abc', '.bimax'));
  expect(stateRoot()).toBe('/app-data/thread-state/abc');
});
