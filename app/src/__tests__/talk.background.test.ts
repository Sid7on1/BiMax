import { talkTrayTitle, type TalkState } from '../shared/talk';

/**
 * Backlog FL11, talking in the background: with the ⌘2 bar hidden the menu bar is the only place the conversation is
 * visible, so every live state must say something there, and "off" must give the menu bar back to the task list.
 */
test('every live talk state has a menu bar title, and off has none', () => {
  const live: TalkState[] = ['starting', 'listening', 'thinking', 'speaking', 'waiting'];
  const titles = live.map((state) => talkTrayTitle({ state }));
  for (const title of titles) expect(title).toMatch(/^🎙 \S/);
  // Distinct, so a glance tells listening from speaking.
  expect(new Set(titles).size).toBe(live.length);
  // "waiting" is the one that needs the user: it must say so, not just "busy".
  expect(talkTrayTitle({ state: 'waiting' })).toBe('🎙 Needs you');
  expect(talkTrayTitle({ state: 'off' })).toBeNull();
});
