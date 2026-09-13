import { DEFAULT_TALK_MODEL, QUIET_END_MS, TALK_TURN_HINT, TalkSession, talkModel, type TalkView } from '../main/talk.session';

function fixture() {
  const commands: Array<Record<string, unknown>> = [];
  const views: TalkView[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let emit: (event: any) => void = () => {};
  let exit: () => void = () => {};
  const end = jest.fn();
  const deps = {
    spawn: jest.fn((onEvent: (event: any) => void, onExit: () => void) => { emit = onEvent; exit = onExit; return { send: (c: Record<string, unknown>) => commands.push(c), end }; }),
    openThread: jest.fn(() => 't1'),
    submit: jest.fn(),
    answer: jest.fn(),
    interrupt: jest.fn(),
    show: (view: TalkView) => views.push(view),
    closed: jest.fn(),
    setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (handle: unknown) => { timers[handle as number].cleared = true; },
  };
  const talk = new TalkSession(deps);
  return {
    talk, deps, commands, end,
    last: () => views[views.length - 1],
    spoken: () => commands.filter((c) => c.cmd === 'speak').map((c) => c.text),
    armed: () => timers.filter((t) => !t.cleared),
    helper: (event: any) => emit(event),
    crash: () => exit(),
  };
}
const token = (text: string) => ({ t: 'event', name: 'stream_token', args: [text] });
const assistant = (content: string) => ({ t: 'event', name: 'message', args: [{ role: 'assistant', content }] });
const idle = { t: 'event', name: 'spinner_state', args: ['idle', ''] };

function listening() {
  const f = fixture();
  f.talk.start();
  f.helper({ event: 'ready', voice: 'Samantha', quality: 'default' });
  return f;
}

test('a spoken turn: listen, send the words, read the reply while it streams, then listen again', () => {
  const f = fixture();
  f.talk.start();
  expect(f.last().state).toBe('starting');
  f.helper({ event: 'downloading', locale: 'en-US' });
  expect(f.last().heard).toBe('Downloading the speech model…');
  f.helper({ event: 'ready', voice: 'Samantha', quality: 'default' });
  expect(f.last()).toMatchObject({ state: 'listening', heard: '', threadId: 't1', voice: { name: 'Samantha', quality: 'default' } });
  expect(f.commands.at(-1)).toEqual({ cmd: 'listen' });
  f.helper({ event: 'partial', text: 'hi' });
  expect(f.last().heard).toBe('hi');
  f.helper({ event: 'utterance', text: 'hi Bimax' });
  // The engine is reminded the turn is spoken; the bar shows only the words.
  expect(f.deps.submit).toHaveBeenCalledWith('t1', 'hi Bimax', `hi Bimax\n\n${TALK_TURN_HINT}`);
  expect(f.last().state).toBe('thinking');
  f.talk.onThreadMessage(token('Hey! Good to '));
  f.talk.onThreadMessage(token('hear you. What shall we do?'));
  expect(f.spoken()).toEqual(['Hey!', 'Good to hear you.']);
  f.helper({ event: 'speaking', text: 'Hey!' });
  expect(f.last().state).toBe('speaking');
  f.talk.onThreadMessage(assistant('Hey! Good to hear you. What shall we do?'));
  expect(f.spoken()).toEqual(['Hey!', 'Good to hear you.', 'What shall we do?']);
  f.talk.onThreadMessage(idle);
  expect(f.commands.at(-1)).toEqual({ cmd: 'flush' });
  f.helper({ event: 'spoken' });
  expect(f.last().state).toBe('listening');
  expect(f.commands.at(-1)).toEqual({ cmd: 'listen' });
});

test('a reply that is not streamed is read from its final message, and a quiet helper mid-turn means thinking', () => {
  const f = listening();
  f.helper({ event: 'utterance', text: 'tidy my downloads' });
  f.talk.onThreadMessage(assistant('Looking now.'));
  expect(f.spoken()).toEqual(['Looking now.']);
  f.helper({ event: 'speaking' });
  f.helper({ event: 'quiet' });
  expect(f.last().state).toBe('thinking');
});

test('a question from the task is answered by voice; an approval card is read out and waits for a click', () => {
  const f = listening();
  f.helper({ event: 'utterance', text: 'tidy a folder' });
  f.talk.onThreadMessage({ t: 'request', id: 5, kind: 'input', isAsk: true, question: 'Which folder should I tidy?' });
  expect(f.spoken()).toEqual(['Which folder should I tidy?']);
  expect(f.commands.at(-1)).toEqual({ cmd: 'flush' });
  f.helper({ event: 'spoken' });
  expect(f.last().state).toBe('listening');
  f.helper({ event: 'utterance', text: 'Downloads' });
  expect(f.deps.answer).toHaveBeenCalledWith('t1', 5, 'Downloads');
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
  f.talk.onThreadMessage({ t: 'request', id: 6, kind: 'prompt', question: 'Move 14 installers to the Bin?', options: ['Allow', 'Deny'] });
  expect(f.spoken().at(-1)).toBe('Move 14 installers to the Bin? Choose on screen.');
  f.helper({ event: 'spoken' });
  expect(f.last().state).toBe('waiting');
  expect(f.commands.at(-1)).not.toEqual({ cmd: 'listen' });
  expect(f.deps.answer).toHaveBeenCalledTimes(1);
});

test('a few choices are read out and answered by voice; a secret or a checklist is left to the screen', () => {
  const f = listening();
  f.helper({ event: 'utterance', text: 'write the sales report' });
  f.talk.onThreadMessage(token('Sure, one thing first'));
  f.talk.onThreadMessage({ t: 'request', id: 8, kind: 'prompt', isAsk: true, question: 'Which quarter?', options: ['Q1', 'Q2', 'Q3'] });
  expect(f.spoken()).toEqual(['Sure, one thing first', 'Which quarter? Q1, Q2 or Q3?']);
  f.helper({ event: 'spoken' });
  f.helper({ event: 'utterance', text: 'the second one' });
  expect(f.deps.answer).toHaveBeenCalledWith('t1', 8, 'the second one');
  f.talk.onThreadMessage({ t: 'request', id: 9, kind: 'input', question: 'Paste the API key', options: [], masked: true });
  expect(f.spoken().at(-1)).toBe('Paste the API key. Type it on screen.');
  f.helper({ event: 'spoken' });
  expect(f.last().state).toBe('waiting');
  f.talk.onThreadMessage({ t: 'request', id: 10, kind: 'prompt', isAsk: true, isMulti: true, question: 'Which files?', options: ['a.txt', 'b.txt'] });
  expect(f.spoken().at(-1)).toBe('Which files? Choose on screen.');
  expect(f.deps.answer).toHaveBeenCalledTimes(1);
});

test('interrupting stops the speech and the task, then listens; ending closes the helper', () => {
  const f = listening();
  f.helper({ event: 'utterance', text: 'explain everything' });
  f.talk.onThreadMessage(token('This is a long answer. '));
  f.helper({ event: 'speaking' });
  f.talk.interrupt();
  expect(f.commands).toContainEqual({ cmd: 'interrupt' });
  expect(f.deps.interrupt).toHaveBeenCalledWith('t1');
  expect(f.last().state).toBe('listening');
  f.talk.onThreadMessage(token('Leftover words from the stopped turn. '));
  f.talk.end();
  expect(f.end).toHaveBeenCalled();
  expect(f.last().state).toBe('off');
  expect(f.armed()).toHaveLength(0);
  expect(f.deps.closed).toHaveBeenCalledWith('t1');
});

test('two quiet minutes of listening end talk mode; speaking restarts the count, and a turn stops it', () => {
  const f = listening();
  expect(f.armed()).toEqual([expect.objectContaining({ ms: QUIET_END_MS })]);
  f.helper({ event: 'partial', text: 'um' });
  expect(f.armed()).toHaveLength(1);
  f.helper({ event: 'utterance', text: 'um, never mind' });
  expect(f.armed()).toHaveLength(0);
  f.talk.onThreadMessage(idle);
  f.helper({ event: 'spoken' });
  expect(f.armed()).toHaveLength(1);
  f.armed()[0].fn();
  expect(f.last()).toMatchObject({ state: 'off', error: 'Talk mode ended after two quiet minutes.' });
  expect(f.end).toHaveBeenCalled();
});

test('a thread that cannot open, or a helper that dies, ends talk mode with a reason', () => {
  const f = listening();
  f.crash();
  expect(f.last()).toMatchObject({ state: 'off', error: 'Talk mode stopped unexpectedly.' });
  expect(f.deps.closed).toHaveBeenCalledWith('t1');
  const g = fixture();
  g.deps.openThread.mockImplementation(() => { throw new Error('Four threads are active. Stop a thread before starting another.'); });
  g.talk.start();
  g.helper({ event: 'ready', voice: 'Samantha' });
  expect(g.last()).toMatchObject({ state: 'off', error: 'Four threads are active. Stop a thread before starting another.' });
  expect(g.end).toHaveBeenCalled();
  expect(g.deps.closed).toHaveBeenCalledWith(null);
});

test('talk mode answers with the quick model when the provider serves it, else the ⌘2 default', () => {
  expect(talkModel([], 'x/quick')).toBe(DEFAULT_TALK_MODEL);
  expect(talkModel([{ id: DEFAULT_TALK_MODEL, served: true }], 'x/quick')).toBe(DEFAULT_TALK_MODEL);
  expect(talkModel([{ id: DEFAULT_TALK_MODEL, served: false }, { id: 'x/quick', served: true }], 'x/quick')).toBe('x/quick');
  expect(talkModel([{ id: 'other/model', served: true }])).toBeUndefined();
});
