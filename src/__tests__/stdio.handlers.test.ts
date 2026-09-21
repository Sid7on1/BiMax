import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { startStdioHost } from '../protocol/stdio.host';
import { INBOUND_FIXTURES, INBOUND_KINDS } from '../protocol/schema/fixtures';

/**
 * Every inbound message kind reaches its handler through the real stdio host.
 *
 * The host is built with its handlers passed BY NAME, so a new handler that is not added to that list is dropped with
 * no error. Measured live 2026-09-21: steering (F7) passed every unit test — they called the session directly — and
 * in the running engine every steer vanished, because `onSteer` was not in the list.
 */
const HANDLED: Record<string, string> = {
  input: 'onInput', interrupt: 'onInterrupt', steer: 'onSteer', query: 'onQuery', menuSelect: 'onMenuSelect',
  configGet: 'onConfigGet', configSet: 'onConfigSet', catalogGet: 'onCatalogGet', providerSet: 'onProviderSet',
  resume: 'onResume', controls: 'onControls',
};
/** Answered by the host itself: a reply resolves a pending request, a ping is answered with a pong. */
const HOST_OWN = new Set(['reply', 'ping']);

test('the table above covers every inbound kind, so a new kind cannot skip this test', () => {
  expect(Object.keys(INBOUND_KINDS).filter((kind) => !HOST_OWN.has(kind)).sort()).toEqual(Object.keys(HANDLED).sort());
});

test('each inbound kind reaches its handler through the stdio host', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const called = new Set<string>();
  const handlers = Object.fromEntries(Object.values(HANDLED).map((name) => [name, (..._args: unknown[]) => { called.add(name); return name === 'onQuery' ? [] : name === 'onConfigGet' || name === 'onConfigSet' ? {} : undefined; }]));
  const dispose = startStdioHost({ emitter: new EventEmitter(), input, output, ...(handlers as any) });
  for (const frame of INBOUND_FIXTURES) input.write(JSON.stringify(frame) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  dispose();
  const expected = [...new Set(INBOUND_FIXTURES.map((frame) => HANDLED[frame.t]).filter(Boolean))].sort();
  expect([...called].sort()).toEqual(expected);
  expect(called.has('onSteer')).toBe(true);
});
