import { engineEvents } from '../engine/events';
import { GlobalPrompter } from '../engine/prompter';

/**
 * Answering a permission prompt must not end the turn on screen. The prompter used to emit spinner "idle"
 * after every answer, so an approved Bash command ran with no activity shown and the desktop's thread manager
 * took the turn for finished (clearing approvals and dispatching queued input into a live turn).
 */
describe('a permission prompt resumes the spinner it interrupted', () => {
  const answerWith = (value: string) => engineEvents.once('veto_prompt', (_q: string, _o: string[], resolve: (a: string) => void) => resolve(value));

  test('mid-turn: thinking → vetoing → thinking', async () => {
    const seen: string[] = [];
    const record = (state: string) => seen.push(state);
    engineEvents.emit('spinner_state', 'thinking', 'Thinking…');
    engineEvents.on('spinner_state', record);
    answerWith('Yes');
    await expect(GlobalPrompter.ask('Allow this action?', ['Yes', 'No'])).resolves.toBe('Yes');
    engineEvents.off('spinner_state', record);
    expect(seen).toEqual(['vetoing', 'thinking']);
  });

  test('outside a turn the prompt still settles to idle', async () => {
    const seen: string[] = [];
    const record = (state: string) => seen.push(state);
    engineEvents.emit('spinner_state', 'idle', 'Ready');
    engineEvents.on('spinner_state', record);
    answerWith('No');
    await expect(GlobalPrompter.ask('Save this key?', ['Yes', 'No'])).resolves.toBe('No');
    engineEvents.off('spinner_state', record);
    expect(seen).toEqual(['vetoing', 'idle']);
  });
});
