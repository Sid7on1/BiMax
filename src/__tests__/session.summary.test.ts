import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acceptTitle, headlineFromPrompt, summarizeSession } from '../engine/session.summary';

/**
 * Fix list item 7 (owner, 2026-09-30): "the recents tab must hold the summary of what that session is
 * for, not the first prompt of the user as its heading".
 */

describe('the immediate headline: the request, without the chatter', () => {
  test.each([
    ['hey can you look at why the build is failing on main after the merge', 'Look at why the build is failing on main after…'],
    ['Please fix the login redirect loop.', 'Fix the login redirect loop'],
    ['ok so i want you to add dark mode to settings', 'Add dark mode to settings'],
    ['Hi Bimax, could you please write tests for the parser? Also check the CLI.', 'Write tests for the parser'],
    ['help me rename the photos in Downloads thanks', 'Rename the photos in Downloads'],
    ['refactor auth', 'Refactor auth'],
  ])('%s', (prompt, headline) => {
    expect(headlineFromPrompt(prompt)).toBe(headline);
  });

  test('nothing but chatter is Untitled, not an empty row', () => {
    expect(headlineFromPrompt('hey')).toBe('Untitled');
    expect(headlineFromPrompt('   ')).toBe('Untitled');
  });

  test('a long request is cut at a word, never mid-word', () => {
    const head = headlineFromPrompt('migrate every service in the monorepo from the old logging library to structured logs');
    expect(head.length).toBeLessThanOrEqual(49);
    expect(head.endsWith('…')).toBe(true);
    expect(head).not.toMatch(/\s…$/);
    expect('migrate every service in the monorepo from the old logging library'.toLowerCase().startsWith(head.slice(0, -1).toLowerCase())).toBe(true);
  });
});

describe('a model title is accepted only when it is a title', () => {
  test('cleaned of quotes, labels and trailing punctuation', () => {
    expect(acceptTitle('"Fix login redirect loop."')).toBe('Fix login redirect loop');
    expect(acceptTitle('Title: Dark mode for settings')).toBe('Dark mode for settings');
    expect(acceptTitle('**Parser test coverage**\nSome explanation')).toBe('Parser test coverage');
  });
  test('refused: a sentence, a refusal, one word, markup', () => {
    expect(acceptTitle('I cannot name this conversation')).toBeNull();
    expect(acceptTitle('Sorry, here is a title')).toBeNull();
    expect(acceptTitle('Build')).toBeNull();
    expect(acceptTitle('This conversation is about fixing the build that broke after the merge on main today')).toBeNull();
    expect(acceptTitle('<think>the user wants')).toBeNull();
    expect(acceptTitle('')).toBeNull();
  });
});

describe('summarizeSession', () => {
  test('asks the Quick model once, bounded, and returns its accepted title', async () => {
    const calls: Array<{ user: string; max?: number }> = [];
    const title = await summarizeSession({ quickText: async (_s, user, max) => { calls.push({ user, max }); return 'Login redirect loop fix'; } },
      'x'.repeat(5000), 'y'.repeat(5000));
    expect(title).toBe('Login redirect loop fix');
    expect(calls).toHaveLength(1);
    expect(calls[0].max).toBe(48);
    expect(calls[0].user.length).toBeLessThan(1500); // the request and reply are cut, not sent whole
  });
  test('a failing, hanging or garbage model gives null, so the headline stands', async () => {
    expect(await summarizeSession({ quickText: async () => { throw new Error('404'); } }, 'a', 'b')).toBeNull();
    expect(await summarizeSession({ quickText: () => new Promise<string>(() => undefined) }, 'a', 'b', 20)).toBeNull();
    expect(await summarizeSession({ quickText: async () => '' }, 'a', 'b')).toBeNull();
  });
});

describe('a session is named after its first reply', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-summary-'));
    cwd = process.cwd();
    process.chdir(dir);
    jest.resetModules();
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Recents shows the model title, and until then the cleaned request — never the raw prompt', async () => {
    const { engineEvents } = require('../engine/events');
    const { startSessionRecorder } = require('../engine/session.recorder');
    const { startSessionSummaries } = require('../engine/session.summary');
    const { buildUiSnapshot } = require('../protocol/ui.snapshot');
    startSessionRecorder();
    let release: (title: string) => void = () => undefined;
    const asked: string[] = [];
    const stop = startSessionSummaries({ quickText: (_s: string, user: string) => { asked.push(user); return new Promise<string>((r) => { release = r; }); } });

    engineEvents.emit('message', { role: 'user', content: 'hey can you fix the flaky upload test please', timestamp: new Date() });
    expect(buildUiSnapshot().sessions?.[0]?.title).toBe('Fix the flaky upload test');

    engineEvents.emit('message', { role: 'assistant', content: 'The upload test races the temp dir cleanup; fixed by awaiting it.', timestamp: new Date() });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('fix the flaky upload test');
    release('Flaky upload test race');
    await new Promise((r) => setTimeout(r, 0));
    expect(buildUiSnapshot().sessions?.[0]?.title).toBe('Flaky upload test race');

    // Later turns do not rename it: one title per session.
    engineEvents.emit('message', { role: 'assistant', content: 'Anything else?', timestamp: new Date() });
    engineEvents.emit('message', { role: 'user', content: 'also bump the timeout', timestamp: new Date() });
    engineEvents.emit('message', { role: 'assistant', content: 'Bumped it to 30s.', timestamp: new Date() });
    expect(asked).toHaveLength(1);
    expect(buildUiSnapshot().sessions?.[0]?.title).toBe('Flaky upload test race');
    stop();
    engineEvents.emit('shutdown');
  });
});
