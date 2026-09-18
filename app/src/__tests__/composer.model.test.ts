import {
  composeMessage, emptyDraft, mentionAt, mentionRef, replaceMention, readDraft, saveDraft, clearDraft,
  completionInsert, slashCommand, commandPrefix, readHistory, pushHistory, HISTORY_LIMIT,
  shouldAttachPaste, pastedFileName, isReferenceable, INLINE_PASTE_LIMIT,
} from '../renderer/src/composer.model';

/**
 * The engine's own parser, copied verbatim from `src/engine/atMention.ts` (FILE_AT_RE). A reference
 * is only correct if THIS reads back the path we meant — asserting on our own output shape would
 * just be checking that the composer agrees with itself.
 */
const FILE_AT_RE = /(?<![A-Za-z0-9_@])@("(?:[^"\\\r\n]|\\.)*"|diff|staged|selection|sel|(?:\.\.?\/|~\/|\/)[^\s,;"'`()[\]{}]*|[A-Za-z0-9_./-]+\/[^\s,;"'`()[\]{}]*)/g;

function enginePaths(text: string): string[] {
  const out: string[] = [];
  FILE_AT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_AT_RE.exec(text)) !== null) {
    let token = match[1];
    if (token.startsWith('"')) {
      try { token = JSON.parse(token); } catch { continue; }
      if (typeof token !== 'string' || !/^(?:\.\.?\/|~\/|\/)/.test(token) || /[\0\r\n]/.test(token)) continue;
    }
    out.push(token);
  }
  return out;
}

describe('composer submission and recovery', () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
  });
  afterAll(() => { delete (globalThis as any).localStorage; });

  test('a brief reaches the engine with explicit output, constraints and success criteria', () => {
    const message = composeMessage({ text: 'Summarize the findings', output: 'Document', constraints: 'Use only attached sources', checks: 'Cite every claim' }, ['notes/Team report.md']);
    expect(message).toContain('Requested output: Document');
    expect(message).toContain('Constraints:\nUse only attached sources');
    expect(message).toContain('Completion checks:\nCite every claim');
    expect(message).toContain('@"./notes/Team report.md"');
    expect(composeMessage({ ...emptyDraft(), text: 'Fix the login bug' })).toBe('Fix the login bug');
  });

  test('completes the token at the cursor without deleting the rest of the instruction', () => {
    const text = 'Compare @src/par with @src/other and explain';
    const caret = text.indexOf(' with');
    expect(replaceMention(text, caret, '@src/parser.ts').text).toBe('Compare @src/parser.ts with @src/other and explain');
    expect(mentionAt('email user@example.com', 22)).toBeNull();
    expect(replaceMention('Leave this alone', 3, '@oops').text).toBe('Leave this alone');
  });

  test('replaces the whole mention even when the caret is within it', () => {
    expect(replaceMention('Read @src/old.ts please', 10, '@src/new.ts').text).toBe('Read @src/new.ts please');
  });

  test('drafts survive remounts, are isolated by project, and clear on task navigation', () => {
    const draft = { ...emptyDraft(), text: 'Preserve this unfinished thought', checks: 'Show sources' };
    expect(saveDraft('/project-a', draft)).toBe(true);
    expect(readDraft('/project-a')).toEqual(draft);
    expect(readDraft('/project-b')).toEqual(emptyDraft());
    clearDraft('/project-a');
    expect(readDraft('/project-a')).toEqual(emptyDraft());
  });

  test('corrupt, expired and unavailable storage do not crash or fabricate a draft', () => {
    values.set('bimax:composer:v1:/a', '{bad');
    expect(readDraft('/a')).toEqual(emptyDraft());
    values.set('bimax:composer:v1:/a', JSON.stringify({ at: 0, draft: { ...emptyDraft(), text: 'expired' } }));
    expect(readDraft('/a')).toEqual(emptyDraft());
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    expect(readDraft('/a')).toEqual(emptyDraft());
    expect(saveDraft('/a', emptyDraft())).toBe(false);
  });
});

describe('@references survive the engine parser', () => {
  /**
   * The defect this pins: a bare `@./notes/Team report.md` is read by the engine as
   * `./notes/Team`, which does not exist, so the reference is dropped with no error at all.
   */
  test('a filename with spaces or punctuation reaches the engine intact', () => {
    for (const path of [
      'notes/Team report.md',
      './Q3 plan (final).xlsx',
      "~/Docs/Owner's brief.pdf",
      '/tmp/a,b;c.txt',
      './say "hello".md',
      './back\\slash.md',
    ]) {
      const rooted = /^(?:\.\.?\/|~\/|\/)/.test(path) ? path : `./${path}`;
      expect(enginePaths(`read ${mentionRef(path)} now`)).toEqual([rooted]);
    }
  });

  test('ordinary paths stay unquoted so the prompt still reads like a sentence', () => {
    expect(mentionRef('./src/parser.ts')).toBe('@./src/parser.ts');
    expect(mentionRef('src/parser.ts')).toBe('@./src/parser.ts');
    expect(mentionRef('/etc/hosts')).toBe('@/etc/hosts');
    expect(mentionRef('~/notes.md')).toBe('@~/notes.md');
  });

  test('every attachment in a composed message is one the engine can resolve', () => {
    const message = composeMessage(
      { ...emptyDraft(), text: 'Reconcile these' },
      ['./billing Q3.csv', './src/ledger.ts', './billing Q3.csv'],
    );
    // De-duplicated, and both survive the round trip.
    expect(enginePaths(message)).toEqual(['./billing Q3.csv', './src/ledger.ts']);
  });

  test('a path the engine cannot express is dropped from the message, not silently truncated', () => {
    expect(isReferenceable('./ok.md')).toBe(true);
    expect(isReferenceable('./two\nlines.md')).toBe(false);
    expect(composeMessage({ ...emptyDraft(), text: 'Look' }, ['./two\nlines.md'])).toBe('Look');
  });

  test('accepting a path completion roots it, and quotes it when the bare form would break', () => {
    expect(completionInsert({ value: '@./src/parser.ts', kind: 'path' })).toBe('@./src/parser.ts');
    expect(completionInsert({ value: '@src/parser.ts', kind: 'path' })).toBe('@./src/parser.ts');
    expect(completionInsert({ value: '@./Team report.md', kind: 'path' })).toBe('@"./Team report.md"');
    expect(completionInsert({ value: '@"./already quoted.md"', kind: 'path' })).toBe('@"./already quoted.md"');
    // A symbol is a graph lookup, not a path: rewriting it to `@./handlePayment` would break it.
    expect(completionInsert({ value: '@handlePayment', kind: 'symbol' })).toBe('@handlePayment');
    // Context verbs are neither: `@./diff` resolves to nothing.
    for (const verb of ['@diff', '@staged', '@selection', '@sel', '@url']) {
      expect(completionInsert({ value: verb, kind: 'path' })).toBe(verb);
    }
  });

  test('a bare filename in the project root is rooted, or the engine never sees it', () => {
    // The defect: the parser matches a bare token only when it starts with `./ ../ ~/ /` OR
    // contains a slash. `@notes.md` has neither, so an offered completion for a file sitting in
    // the project root produced a reference that resolved to nothing at all.
    expect(enginePaths('read @notes.md now')).toEqual([]);
    expect(enginePaths(`read ${completionInsert({ value: '@notes.md', kind: 'path' })} now`)).toEqual(['./notes.md']);
    expect(enginePaths(`read ${completionInsert({ value: '@Team report.md', kind: 'path' })} now`)).toEqual(['./Team report.md']);
  });

  test('a quoted reference is edited and completed as one token', () => {
    const text = 'Read @"./Team rep" and summarize';
    const caret = text.indexOf(' rep') + 4; // inside the quotes
    expect(mentionAt(text, caret)?.token).toBe('@"./Team rep');
    expect(replaceMention(text, caret, '@"./Team report.md"').text).toBe('Read @"./Team report.md" and summarize');
  });

  test('the caret after a finished reference is not treated as being inside it', () => {
    const text = 'Read @"./a b.md" then stop';
    expect(mentionAt(text, text.indexOf(' then') + 1)).toBeNull();
    expect(mentionAt('Read @./a.md ', 13)).toBeNull();
  });
});

describe('slash commands are reachable from the composer', () => {
  test('a one-word command is a command; prose and pasted paths are not', () => {
    expect(slashCommand('/clear')).toBe('/clear');
    expect(slashCommand('  /clear force  ')).toBe('/clear force');
    expect(slashCommand('/Users/me/notes.md')).toBeNull();
    expect(slashCommand('Use the and/or form')).toBeNull();
    expect(slashCommand('/model\nand then build it')).toBeNull();
    expect(slashCommand('')).toBeNull();
  });

  test('completions are requested only while the command name itself is being typed', () => {
    expect(commandPrefix('/cle', 4)).toBe('/cle');
    expect(commandPrefix('/', 1)).toBe('/');
    expect(commandPrefix('/clear force', 12)).toBeNull();
    expect(commandPrefix('read @./a.md', 12)).toBeNull();
  });
});

describe('prompt history persists the way the draft does', () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
  });
  afterAll(() => { delete (globalThis as any).localStorage; });

  test('sent prompts come back after a remount, scoped to their project', () => {
    pushHistory('/a', 'first request');
    pushHistory('/a', 'second request');
    expect(readHistory('/a')).toEqual(['first request', 'second request']);
    expect(readHistory('/b')).toEqual([]);
  });

  test('a repeated prompt moves to the end instead of stacking up', () => {
    pushHistory('/a', 'run the tests');
    pushHistory('/a', 'fix the bug');
    pushHistory('/a', 'run the tests');
    expect(readHistory('/a')).toEqual(['fix the bug', 'run the tests']);
  });

  test('history is bounded, ignores blanks, and tolerates corrupt or unavailable storage', () => {
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) pushHistory('/a', `request ${i}`);
    const kept = readHistory('/a');
    expect(kept).toHaveLength(HISTORY_LIMIT);
    expect(kept[kept.length - 1]).toBe(`request ${HISTORY_LIMIT + 9}`);
    expect(pushHistory('/a', '   ')).toEqual(kept);
    values.set('bimax:composer:history:v1:/c', '{not json');
    expect(readHistory('/c')).toEqual([]);
    values.set('bimax:composer:history:v1:/c', JSON.stringify(['keep', 42, null, '']));
    expect(readHistory('/c')).toEqual(['keep']);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    expect(readHistory('/c')).toEqual([]);
    expect(() => pushHistory('/c', 'still works')).not.toThrow();
  });
});

describe('large pastes become attachments', () => {
  test('an ordinary paste stays inline; a log-sized one does not', () => {
    expect(shouldAttachPaste('a stack trace line')).toBe(false);
    expect(shouldAttachPaste('x'.repeat(INLINE_PASTE_LIMIT))).toBe(false);
    expect(shouldAttachPaste('x'.repeat(INLINE_PASTE_LIMIT + 1))).toBe(true);
  });

  test('pasted files are named from the clock, never from the pasted content', () => {
    const at = new Date(2026, 8, 7, 4, 5, 6);
    expect(pastedFileName('image', at)).toBe('Pasted image 2026-09-07 040506.png');
    expect(pastedFileName('text', at)).toBe('Pasted text 2026-09-07 040506.txt');
  });
});
