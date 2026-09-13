import { CapabilityReplay } from '../main/capability.replay';
import { engineReducer, initialEngineState } from '../renderer/src/engine.state';
const fault = { t: 'event' as const, name: 'message', args: [{ role: 'system', id: 'fixture', content: 'Failed',
  payload: { capabilityStatus: { id: 'embeddings', label: 'Semantic retrieval', state: 'degraded', reason: 'Failed', impact: 'Keywords only', action: 'Retry', observedAt: new Date().toISOString() } } }] };

test('a fresh renderer sees unresolved failures; recovery, engine restart and project switch remove stale ones', () => {
  const replay = new CapabilityReplay(); replay.accept(fault);
  const reloaded = replay.snapshot().reduce((state, msg) => engineReducer(state, { type: 'outbound', msg }), initialEngineState);
  expect(reloaded.capabilities.embeddings.state).toBe('degraded');
  const recovery = JSON.parse(JSON.stringify(fault)); recovery.args[0].payload.capabilityStatus.state = 'ready';
  replay.accept(recovery); expect(replay.snapshot()).toEqual([]);
  replay.accept(fault); replay.accept({ t: 'ready' }); expect(replay.snapshot()).toEqual([]);
  expect(engineReducer(reloaded, { type: 'outbound', msg: { t: 'ready', protocol: 3 } }).capabilities).toEqual({});
  replay.accept(fault); replay.clear(); expect(replay.snapshot()).toEqual([]);
});
