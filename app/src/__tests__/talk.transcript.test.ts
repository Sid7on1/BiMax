import { engineReducer, initialEngineState } from '../renderer/src/engine.state';
import { TALK_TURN_HINT } from '../shared/talk';

const event = (name: string, args: unknown[]) => ({ type: 'outbound' as const, msg: { t: 'event', name, args } as any });
const users = (state: typeof initialEngineState) => state.items.filter((i) => i.kind === 'msg' && i.msg.role === 'user').map((i) => (i.kind === 'msg' ? i.msg.content : ''));

test('a spoken turn shows only what was said: live, when the engine echoes it, and after the conversation resumes', () => {
  let state = engineReducer(initialEngineState, { type: 'localUser', text: 'Hi' });
  state = engineReducer(state, event('message', [{ id: 'u1', role: 'user', content: `Hi\n\n${TALK_TURN_HINT}`, timestamp: 't' }]));
  expect(users(state)).toEqual(['Hi']);

  const resumed = engineReducer(initialEngineState, event('session_restore', [{ id: 's', entries: [
    { id: 'u1', role: 'user', content: `Hi\n\n${TALK_TURN_HINT}`, timestamp: 't' },
    { id: 'a1', role: 'assistant', content: 'Hey there!', timestamp: 't' },
    { id: 'u2', role: 'user', content: 'a typed [bracketed] question', timestamp: 't' },
  ] }]));
  expect(users(resumed)).toEqual(['Hi', 'a typed [bracketed] question']);
});
