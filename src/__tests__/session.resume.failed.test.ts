import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../engine/commands/session';
import { globalCommandRegistry } from '../engine/commands/registry';
import { engineEvents } from '../engine/events';

/**
 * Backlog F9 (record 46, T02): when a resume cannot happen, the engine says so on the wire with the id it was asked for,
 * so a front-end waiting on that id can stop waiting.
 */

let dir: string;
let previousStateDir: string | undefined;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-resume-failed-'));
  previousStateDir = process.env.BIMAX_STATE_DIR;
  process.env.BIMAX_STATE_DIR = dir;
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.BIMAX_STATE_DIR;
  else process.env.BIMAX_STATE_DIR = previousStateDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/resume of a saved conversation that is not there emits session_restore_failed with its id and reason', async () => {
  const failed = jest.fn();
  const restored = jest.fn();
  engineEvents.on('session_restore_failed', failed);
  engineEvents.on('session_restore', restored);
  try {
    const result = await globalCommandRegistry.execute('/resume 2026-01-01_00-00-00', { restoreMessages: () => true, addSystemMessage: () => {} } as any);
    expect(failed).toHaveBeenCalledWith({ id: '2026-01-01_00-00-00', reason: 'no saved conversation has that id' });
    expect(restored).not.toHaveBeenCalled();
    expect((result as any).content).toContain('No session matching');
  } finally {
    engineEvents.off('session_restore_failed', failed);
    engineEvents.off('session_restore', restored);
  }
});

test('the event is part of the wire contract, so the host forwards it to the app', () => {
  const protocol = fs.readFileSync(path.join(__dirname, '..', 'protocol', 'protocol.ts'), 'utf8');
  expect(protocol).toMatch(/'session_restore_failed',/);
});
