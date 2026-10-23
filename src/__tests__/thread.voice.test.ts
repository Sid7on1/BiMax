import { voiceModeSection } from '../tools/thread.voice';

afterEach(() => { delete process.env.BIMAX_THREAD_VOICE; });

test('only a talk-mode thread is told its reply will be spoken, and never to use markdown', () => {
  expect(voiceModeSection()).toBe('');
  process.env.BIMAX_THREAD_VOICE = '1';
  const section = voiceModeSection();
  expect(section).toContain('SPOKEN CONVERSATION');
  expect(section).toMatch(/Never use markdown/);
  expect(section).toMatch(/approves it on screen/);
  // Backlog Q1: spoken replies stopped with "Is that all you need?" after every answer.
  expect(section).toMatch(/Do not end with a check-in question/);
});
