import { EventEmitter } from 'node:events';
import { helperArguments, splitVoiceLines, talkHelper, VoiceSessions, voiceHelperPath, voiceSupported, type VoiceEvent } from '../main/voice';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: { write: jest.fn() },
    stdout: new EventEmitter(),
    kill: jest.fn(() => true),
  });
  return child;
}

function fixture() {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn = jest.fn((_args: string[]) => { const c = fakeChild(); children.push(c); return c; });
  const sent: Array<[number, VoiceEvent]> = [];
  const timers: Array<() => void> = [];
  const sessions = new VoiceSessions({ spawn, send: (owner, event) => sent.push([owner, event]), setTimeout: (fn) => timers.push(fn) });
  return { sessions, spawn, children, sent, timers };
}

test('helper output is read line by line, across chunks, ignoring anything that is not an event', () => {
  const first = splitVoiceLines('{"event":"ready"}\n{"event":"partial","te');
  expect(first.events).toEqual([{ event: 'ready' }]);
  const second = splitVoiceLines(`${first.rest}xt":"hi"}\nwarning: noise\n\n`);
  expect(second.events).toEqual([{ event: 'partial', text: 'hi' }]);
  expect(second.rest).toBe('');
});

test('a dictation starts the helper with the languages and expected words, reports to its window, and stops once', () => {
  const f = fixture();
  f.sessions.start(7, { locales: ['en-IN', 'en-US', 'not a locale!'], context: ['Bimax', 'Downloads', 'Bimax', 'a,b'] });
  expect(f.spawn).toHaveBeenCalledWith(['--listen', '--locale', 'en-IN,en-US', '--context', 'Bimax,Downloads,a b']);
  const child = f.children[0];
  child.stdout.emit('data', '{"event":"ready"}\n{"event":"final","text":"Hello"}\n');
  f.sessions.stop(7);
  expect(child.stdin.write).toHaveBeenCalledWith('stop\n');
  child.stdout.emit('data', '{"event":"stopped"}\n');
  child.emit('exit', 0);
  expect(f.sent).toEqual([[7, { event: 'ready' }], [7, { event: 'final', text: 'Hello' }], [7, { event: 'stopped' }]]);
  f.timers.forEach((run) => run());
  expect(child.kill).not.toHaveBeenCalled();
});

test('only one microphone session: a second window cancels the first, and another window cannot stop it', () => {
  const f = fixture();
  f.sessions.start(1, { locales: [], context: [] });
  f.sessions.start(2, { locales: [], context: [] });
  expect(f.children[0].stdin.write).toHaveBeenCalledWith('cancel\n');
  f.sessions.stop(1);
  expect(f.children[1].stdin.write).not.toHaveBeenCalled();
  f.timers.forEach((run) => run());
  expect(f.children[0].kill).toHaveBeenCalled();
  f.children[0].emit('exit', null);
  expect(f.sent).toEqual([[1, { event: 'stopped' }]]);
  expect(f.sessions.activeOwner).toBe(2);
});

test('a crash still ends the session, but a failure the helper explained keeps its own message', () => {
  const f = fixture();
  f.sessions.start(3, { locales: [], context: [] });
  f.children[0].emit('exit', 1);
  expect(f.sent.at(-1)).toEqual([3, { event: 'stopped', code: 'helper', message: 'Dictation stopped unexpectedly.' }]);
  f.sessions.start(4, { locales: [], context: [] });
  f.children[1].stdout.emit('data', '{"event":"error","code":"microphone-denied","message":"Microphone access is off for Bimax."}\n');
  f.children[1].emit('exit', 1);
  expect(f.sent.slice(-2)).toEqual([[4, { event: 'error', code: 'microphone-denied', message: 'Microphone access is off for Bimax.' }], [4, { event: 'stopped' }]]);
});

test('dictation is offered only on macOS 26 or later with the helper present', () => {
  expect(voiceSupported('darwin', '25.5.0', true)).toBe(true);
  expect(voiceSupported('darwin', '24.6.0', true)).toBe(false);
  expect(voiceSupported('darwin', '25.5.0', false)).toBe(false);
  expect(voiceSupported('linux', '25.5.0', true)).toBe(false);
  expect(voiceHelperPath({ packaged: true, resourcesPath: '/A/Resources', appPath: '/x' })).toBe('/A/Resources/voice/bimax-voice');
  expect(voiceHelperPath({ packaged: false, resourcesPath: '/A/Resources', appPath: '/dev/app' })).toBe('/dev/app/voice/bimax-voice');
});

test('talk mode runs one helper: events in, commands out as JSON lines, and an end that cannot hang', () => {
  expect(helperArguments('--talk', { locales: ['en-US'], context: ['Bimax', 'Downloads'] })).toEqual(['--talk', '--locale', 'en-US', '--context', 'Bimax,Downloads']);
  const child = fakeChild();
  const events: unknown[] = [];
  const exits = jest.fn();
  const timers: Array<() => void> = [];
  const helper = talkHelper(child, (e) => events.push(e), exits, (fn) => timers.push(fn));
  child.stdout.emit('data', '{"event":"ready","voice":"Samantha"}\n{"event":"utter');
  child.stdout.emit('data', 'ance","text":"hi"}\n');
  expect(events).toEqual([{ event: 'ready', voice: 'Samantha' }, { event: 'utterance', text: 'hi' }]);
  helper.send({ cmd: 'speak', text: 'Hey.' });
  expect(child.stdin.write).toHaveBeenCalledWith('{"cmd":"speak","text":"Hey."}\n');
  helper.end();
  expect(child.stdin.write).toHaveBeenLastCalledWith('{"cmd":"end"}\n');
  timers.forEach((run) => run());
  expect(child.kill).toHaveBeenCalled();
  child.emit('close', null);
  child.emit('close', null);
  expect(exits).toHaveBeenCalledTimes(1);
  helper.send({ cmd: 'listen' });
  expect(child.stdin.write).toHaveBeenCalledTimes(2);
});

test('a talk helper that explains its failure keeps the explanation, even when the words arrive after it exits', () => {
  const child = fakeChild();
  const events: unknown[] = [];
  const exits = jest.fn();
  talkHelper(child, (e) => events.push(e), exits, () => {});
  child.emit('exit', 1);
  child.stdout.emit('data', '{"event":"error","code":"microphone-denied","message":"Microphone access is off for Bimax."}\n');
  expect(exits).not.toHaveBeenCalled();
  child.emit('close', 1);
  expect(events).toEqual([{ event: 'error', code: 'microphone-denied', message: 'Microphone access is off for Bimax.' }]);
  expect(exits).toHaveBeenCalledTimes(1);
});
