/**
 * The supervisor surface, diagnostics export and evidence timeline, moved out of main/index.ts into diagnostics.ipc.ts
 * (flaw list C13). The recovery lever takes only a known action, the engine log is redacted, and a delete names a
 * scope — checked here through a stand-in gate.
 */

const engineLog = { text: '' };
jest.mock('electron', () => ({ dialog: { showSaveDialog: jest.fn() } }));
jest.mock('../main/engine', () => ({ recentEngineLog: () => engineLog.text }));

import { registerDiagnosticsIpc } from '../main/diagnostics.ipc';
import { InvalidPayloadError } from '../main/security';
import type { IpcGate } from '../main/ipc.gate';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const gate: IpcGate = { handle: (channel, _fallback, fn) => { handlers.set(channel, fn as Handler); }, on: () => undefined };
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

const actions: string[] = [];
const deleted: string[] = [];
registerDiagnosticsIpc(gate, {
  supervisor: () => ({ status: () => ({ state: 'ready' }), handleAction: (a: string) => { actions.push(a); return true; }, crashHistory: () => [], diagnosticsText: () => 'text' }) as never,
  lastStatus: () => null,
  mainWindow: () => null,
  evidence: {
    all: () => [], forTask: () => [], evictionLog: () => [],
    deleteTask: (id: string) => { deleted.push(`task:${id}`); return 1; },
    deleteObservations: () => { deleted.push('observations'); return 2; },
    deleteAll: () => { deleted.push('all'); return 3; },
  } as never,
});

test('the channels it registers', () => {
  expect([...handlers.keys()].sort()).toEqual([
    'evidence:delete', 'evidence:retention-controls', 'evidence:timeline',
    'supervisor:action', 'supervisor:crash-history', 'supervisor:diagnostics', 'supervisor:engine-log', 'supervisor:get-status',
    'trust:export-diagnostics',
  ]);
});

test('the recovery lever takes only a known action', () => {
  expect(() => call('supervisor:action', 'rm -rf /')).toThrow(InvalidPayloadError);
  expect(actions).toEqual([]);
});

test('the live engine log is redacted before the renderer sees it', () => {
  engineLog.text = 'Authorization: Bearer nvapi-q7Zr2LmX9vKc4TbW1yHs8NdPf3GjU6oEa0RiQlVxYnMkBzCuDw5eFtAg\nready';
  expect(call('supervisor:engine-log')).not.toContain('nvapi-q7Zr2');
});

test('an evidence delete must name its scope; each scope deletes only its own records', () => {
  expect(() => call('evidence:delete', { scope: 'everything' })).toThrow(InvalidPayloadError);
  expect(() => call('evidence:delete', { scope: 'task' })).toThrow(InvalidPayloadError);
  expect(call('evidence:delete', { scope: 'task', taskIntentId: 't-1' })).toBe(1);
  expect(call('evidence:delete', { scope: 'observations' })).toBe(2);
  expect(deleted).toEqual(['task:t-1', 'observations']);
});

test('with no main window the export fails closed instead of opening a dialog', async () => {
  await expect(call('trust:export-diagnostics')).resolves.toBe('failed');
});
