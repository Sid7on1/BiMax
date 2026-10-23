import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { onlyBasicVoices, parseVoiceList, pickerVoices, qualityLabel, speakingArguments, validRate, validVoice, type VoiceOption } from '../main/voice.settings';
import { helperArguments, localeArguments } from '../main/voice';

/** Backlog N7: choose talk mode's voice and speed, and say when no natural voice is installed. */

const v = (id: string, name: string, quality: VoiceOption['quality'] = 'default', language = 'en-US'): VoiceOption => ({ id, name, language, quality });

test('the helper’s voices line is read, and anything malformed is left out', () => {
  const out = [
    'not json',
    JSON.stringify({ event: 'speaking' }),
    JSON.stringify({ event: 'voices', automatic: 'com.apple.voice.compact.en-US.Samantha', voices: [
      { id: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'default' },
      { id: 'com.apple.voice.premium.en-US.Zoe', name: 'Zoe', language: 'en-US', quality: 'premium' },
      { id: 'bad id; rm -rf', name: 'Evil', language: 'en-US', quality: 'premium' },
      { id: 'com.apple.x', name: 7, language: 'en-US' },
      { id: 'com.apple.voice.enhanced.en-GB.Kate', name: 'Kate', language: 'en-GB', quality: 'weird' },
    ] }),
  ].join('\n');
  expect(parseVoiceList(out)).toEqual({ automatic: 'com.apple.voice.compact.en-US.Samantha', voices: [
    v('com.apple.voice.compact.en-US.Samantha', 'Samantha'),
    v('com.apple.voice.premium.en-US.Zoe', 'Zoe', 'premium'),
    v('com.apple.voice.enhanced.en-GB.Kate', 'Kate', 'default', 'en-GB'),
  ] });
  expect(parseVoiceList('')).toEqual({ voices: [], automatic: '' });
  expect(parseVoiceList(JSON.stringify({ event: 'voices', voices: [], automatic: 'a b' })).automatic).toBe('');
});

test('the picker puts the best voices first and leaves out the novelty voices unless one is chosen', () => {
  const all = [
    v('com.apple.speech.synthesis.voice.Zarvox', 'Zarvox'),
    v('com.apple.voice.compact.en-US.Samantha', 'Samantha'),
    v('com.apple.eloquence.en-US.Eddy', 'Eddy'),
    v('com.apple.voice.enhanced.en-US.Ava', 'Ava', 'enhanced'),
    v('com.apple.voice.premium.en-US.Zoe', 'Zoe', 'premium'),
  ];
  expect(pickerVoices(all, undefined).map((x) => x.name)).toEqual(['Zoe', 'Ava', 'Eddy', 'Samantha']);
  expect(pickerVoices(all, 'com.apple.speech.synthesis.voice.Zarvox').map((x) => x.name)).toEqual(['Zoe', 'Ava', 'Eddy', 'Samantha', 'Zarvox']);
});

test('the tip about natural voices shows only when every voice is basic', () => {
  expect(onlyBasicVoices([v('a', 'A'), v('b', 'B')])).toBe(true);
  expect(onlyBasicVoices([v('a', 'A'), v('b', 'B', 'enhanced')])).toBe(false);
  expect(qualityLabel('premium')).toBe('Premium');
  expect(qualityLabel('default')).toBe('Basic');
});

test('only a real voice id and an offered speed reach the helper', () => {
  expect(speakingArguments({})).toEqual([]);
  expect(speakingArguments({ talkVoice: 'com.apple.voice.premium.en-US.Zoe', talkRate: 1.25 })).toEqual(['--voice', 'com.apple.voice.premium.en-US.Zoe', '--rate', '1.25']);
  expect(speakingArguments({ talkVoice: '--say hi', talkRate: 7 })).toEqual([]);
  expect(speakingArguments({ talkVoice: '', talkRate: 1 })).toEqual([]);
  expect(validVoice('a'.repeat(201))).toBeUndefined();
  expect(validRate(0.8)).toBe(0.8);
  expect(validRate('1.5')).toBe(1);
});

test('locales are passed the same way for every helper command', () => {
  expect(localeArguments(['en-IN', 'en-US', 'bad locale!'])).toEqual(['--locale', 'en-IN,en-US']);
  expect(localeArguments([])).toEqual([]);
  expect(helperArguments('--talk', { locales: ['en-IN'], context: ['Bimax'] })).toEqual(['--talk', '--locale', 'en-IN', '--context', 'Bimax']);
});

const helper = path.join(__dirname, '../../voice/bimax-voice');
(process.platform === 'darwin' && existsSync(helper) ? test : test.skip)('the real helper’s voice list reads cleanly', () => {
  const list = parseVoiceList(execFileSync(helper, ['--voices', '--locale', 'en-US'], { encoding: 'utf8', timeout: 20_000 }));
  expect(list.voices.length).toBeGreaterThan(0);
  expect(list.voices.every((voice) => voice.language.startsWith('en'))).toBe(true);
  expect(list.voices.map((voice) => voice.id)).toContain(list.automatic);
});
