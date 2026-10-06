import { EventEmitter } from 'events';
import { MessageChannel } from 'node:worker_threads';
import { startPortHost } from '../protocol/port.host';
import { INBOUND_FIXTURES, INBOUND_KINDS } from '../protocol/schema/fixtures';

/**
 * Every inbound message kind reaches its handler through the real protocol host (the port host — the only one since
 * record 64's M4; this file was stdio.handlers.test.ts and drove the stdio host the same way).
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
/**
 * Answered by the host itself: a reply resolves a pending request, a ping is answered with a pong, and a host_result
 * is ignored after Computer Use retirement — proven end to end through the port host below.
 */
const HOST_OWN = new Set(['reply', 'ping', 'host_result']);

test('the table above covers every inbound kind, so a new kind cannot skip this test', () => {
  expect(Object.keys(INBOUND_KINDS).filter((kind) => !HOST_OWN.has(kind)).sort()).toEqual(Object.keys(HANDLED).sort());
});

test('each inbound kind reaches its handler through the port host', async () => {
  const { port1, port2 } = new MessageChannel();
  const called = new Set<string>();
  const handlers = Object.fromEntries(Object.values(HANDLED).map((name) => [name, (..._args: unknown[]) => { called.add(name); return name === 'onQuery' ? [] : name === 'onConfigGet' || name === 'onConfigSet' ? {} : undefined; }]));
  const dispose = startPortHost({ emitter: new EventEmitter(), port: port1, ...(handlers as any) });
  for (const frame of INBOUND_FIXTURES) port2.postMessage(frame);
  await new Promise((resolve) => setTimeout(resolve, 50));
  dispose();
  port1.close();
  const expected = [...new Set(INBOUND_FIXTURES.map((frame) => HANDLED[frame.t]).filter(Boolean))].sort();
  expect([...called].sort()).toEqual(expected);
  expect(called.has('onSteer')).toBe(true);
});

// The heartbeat's own test is in port.host.test.ts ('the heartbeat goes out on the port, through the queue …').

test('a retired host call refuses immediately and sends nothing to the app', async () => {
  const { port1, port2 } = new MessageChannel();
  const emitter = new EventEmitter();
  const outbound: any[] = [];
  port2.on('message', (frame) => { for (const line of String(frame).split('\n').filter(Boolean)) { try { outbound.push(JSON.parse(line)); } catch {} } });
  const dispose = startPortHost({ emitter, port: port1 } as any);
  const results: unknown[] = [];
  try {
    for (const capability of ['look', 'press', 'type', 'scroll']) {
      emitter.emit('host_call', capability, 'old_operation', {}, (r: unknown) => results.push(r));
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(outbound.filter(m => m.t === 'host_call')).toEqual([]);
    expect(results).toEqual(Array(4).fill({ ok: false, error: 'Computer Use has been removed from Bimax.' }));
    port2.postMessage({ t: 'host_result', id: 1, ok: true, value: { text: 'Notes' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(results).toHaveLength(4);
    // Positive control: the coding protocol remains live on this exact port.
    port2.postMessage({ t: 'ping', id: 71 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(outbound).toContainEqual({ t: 'pong', id: 71 });
  } finally { dispose(); port1.close(); port2.close(); }
});
