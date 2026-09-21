import { PUSH_TALK_CHOICES, PushToTalk, pushTalkAnswer, pushTalkChoice, spokenSummary, type PushTalkDeps } from '../main/push.talk';

/** Backlog N8: hold a shortcut anywhere, speak, let go — a ⌘2 task in Finder's folder, answered out loud or shown. */

function rig(folder: string | null = '/Users/me/invoices') {
  const log: string[] = [];
  const deps: PushTalkDeps = {
    listen: (key) => log.push(`listen ${key}`),
    stop: () => log.push('stop'),
    folder: async () => folder,
    submit: (root, words) => log.push(`submit ${root}: ${words}`),
    openBar: (words) => log.push(`bar: ${words}`),
    indicate: (on) => log.push(on ? 'on' : 'off'),
    tell: (message) => log.push(`tell ${message}`),
  };
  return { log, talk: new PushToTalk(deps) };
}
const space = pushTalkChoice('Control+Alt+Command+Space')!;

test('press, speak, release: the words become a task in Finder’s folder', async () => {
  const { log, talk } = rig();
  await talk.press(space);
  expect(talk.listening).toBe(true);
  talk.onEvent({ event: 'partial', text: 'rename the' });
  talk.onEvent({ event: 'final', text: 'Rename the PDFs ' });
  talk.onEvent({ event: 'final', text: ' by month.' });
  talk.onEvent({ event: 'stopped' }); // the helper saw the key released
  expect(log).toEqual(['on', 'listen 49', 'off', 'submit /Users/me/invoices: Rename the PDFs by month.']);
  expect(talk.listening).toBe(false);
});

test('a second press sends, when the key could not be watched', async () => {
  const { log, talk } = rig();
  await talk.press(space);
  talk.onEvent({ event: 'hold', armed: false } as never);
  talk.onEvent({ event: 'final', text: 'What changed today?' });
  await talk.press(space);
  expect(log.slice(-1)).toEqual(['stop']);
  await talk.press(space); // pressed again while the last words settle: ignored
  expect(log.filter((l) => l === 'stop')).toHaveLength(1);
  talk.onEvent({ event: 'stopped' });
  expect(log.slice(-2)).toEqual(['off', 'submit /Users/me/invoices: What changed today?']);
});

test('no folder: the words go into the ⌘2 bar so the person picks one', async () => {
  const { log, talk } = rig(null);
  await talk.press(space);
  talk.onEvent({ event: 'final', text: 'Tidy up.' });
  talk.onEvent({ event: 'stopped' });
  expect(log.slice(-1)).toEqual(['bar: Tidy up.']);
});

test('nothing heard, a cancel, or an error sends nothing and says why once', async () => {
  const silent = rig();
  await silent.talk.press(space);
  silent.talk.onEvent({ event: 'stopped' });
  expect(silent.log.slice(-1)).toEqual(['tell Bimax didn’t hear anything.']);

  const cancelled = rig();
  await cancelled.talk.press(space);
  cancelled.talk.onEvent({ event: 'final', text: 'never mind' });
  cancelled.talk.onEvent({ event: 'stopped', cancelled: true });
  expect(cancelled.log).toEqual(['on', 'listen 49', 'off']);

  const failing = rig();
  await failing.talk.press(space);
  failing.talk.onEvent({ event: 'error', code: 'microphone-denied', message: 'Microphone access is off for Bimax.' });
  failing.talk.onEvent({ event: 'stopped' });
  expect(failing.log.filter((l) => l.startsWith('tell'))).toEqual(['tell Microphone access is off for Bimax.']);

  const helperDied = rig();
  await helperDied.talk.press(space);
  helperDied.talk.onEvent({ event: 'stopped', code: 'helper', message: 'Dictation stopped unexpectedly.' });
  expect(helperDied.log.slice(-1)).toEqual(['tell Dictation stopped unexpectedly.']);
});

test('events after the session ended are ignored', () => {
  const { log, talk } = rig();
  talk.onEvent({ event: 'final', text: 'stray' });
  talk.onEvent({ event: 'stopped' });
  expect(log).toEqual([]);
});

test('only offered shortcuts, each with the key the helper watches; the answer is spoken unless set otherwise', () => {
  expect(pushTalkChoice('Control+Alt+T')).toEqual({ accelerator: 'Control+Alt+T', label: '⌃⌥T', keyCode: 17 });
  expect(pushTalkChoice('Command+Q')).toBeNull();
  expect(pushTalkChoice(undefined)).toBeNull();
  expect(PUSH_TALK_CHOICES.every((c) => Number.isInteger(c.keyCode))).toBe(true);
  expect(pushTalkAnswer(undefined)).toBe('voice');
  expect(pushTalkAnswer('notification')).toBe('notification');
  expect(pushTalkAnswer('shout')).toBe('voice');
});

test('what is read out: plain words, whole sentences, about 300 characters at most', () => {
  expect(spokenSummary('**Done.** Renamed `12` files — see [the list](file:///x).')).toBe('Done. Renamed 12 files — see the list.');
  expect(spokenSummary('Here:\n```js\nconst a = 1;\n```\nThat is all.')).toBe('Here: That is all.');
  const long = `${'One sentence here. '.repeat(30)}`;
  const said = spokenSummary(long);
  expect(said.length).toBeLessThanOrEqual(300);
  expect(said.endsWith('here.')).toBe(true);
  expect(spokenSummary('x'.repeat(400))).toBe(`${'x'.repeat(299)}…`);
});
