import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recallQuery, recallKey, recallForTurn, RECALL_PREFIX } from '../memory/recall';
import { VectorStore } from '../memory/vector.store';

/**
 * The recall policy — the stage that decides whether the rest of the pipeline is ever used.
 *
 * Retrieval used to be reachable only through a tool, which made recall conditional on the model
 * noticing it might not know something. These tests pin the guards that keep automatic recall from
 * becoming the opposite problem: a block of stale text injected into every turn.
 */

describe('when recall fires', () => {
  const none = new Set<string>();
  const REAL = 'why does the permission dialog keep saying it is off';

  test('fires on a substantial user question', () => {
    expect(recallQuery('user', REAL, none)).toBe(REAL);
  });

  test('never on an assistant or tool turn', () => {
    // The turns between user messages are the model reacting to its own output. Nothing new has
    // been asked, so there is nothing new to recall against.
    expect(recallQuery('assistant', REAL, none)).toBeNull();
    expect(recallQuery('tool', REAL, none)).toBeNull();
  });

  test('never on an acknowledgement', () => {
    // "yes" carries no retrievable intent; searching on it returns whatever ranks highest for noise.
    for (const filler of ['yes', 'ok', 'continue', 'try again', 'do it']) {
      expect(recallQuery('user', filler, none)).toBeNull();
    }
  });

  test('never on a slash command', () => {
    expect(recallQuery('user', '/retrieval show me the current state', none)).toBeNull();
  });

  test('never on our own injected block — a recall must not recall against a recall', () => {
    expect(recallQuery('user', `${RECALL_PREFIX} — something previously retrieved`, none)).toBeNull();
  });

  test('never twice for the same question in one session', () => {
    const asked = new Set([recallKey(REAL)]);
    expect(recallQuery('user', REAL, asked)).toBeNull();
    // Normalised, so whitespace and case do not defeat the check.
    expect(recallQuery('user', `  WHY does the   PERMISSION dialog keep saying it is off `, asked)).toBeNull();
  });

  test('non-string content is ignored rather than stringified', () => {
    // Multimodal turns arrive as content arrays. `String(array)` would produce a query of
    // "[object Object]" and search on it.
    expect(recallQuery('user', [{ type: 'text', text: REAL }], none)).toBeNull();
  });
});

describe('what recall injects', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-recall-'));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('formats what it found, and marks it as retrieved rather than stated', async () => {
    // The block must be attributable. Presented as the user's words, a half-relevant old note
    // reads to the model as a fresh instruction.
    const store = new VectorStore(null);
    await store.storeDocument('note', 'The permission coach polls once a second and blocks the main process', []);

    // Worded with the note's subject: a question mostly about words no memory contains is abstained on (step 7).
    const recalled = await recallForTurn(store, 'why does the permission coach keep blocking the main process');
    expect(recalled).not.toBeNull();
    expect(recalled!.text.startsWith(RECALL_PREFIX)).toBe(true);
    expect(recalled!.text).toMatch(/retrieved for this turn, not stated by the user/i);
    expect(recalled!.text).toContain('polls once a second');
    expect(recalled!.ids).toContain('note');
  });

  test('returns null when nothing matches, rather than injecting an empty block', async () => {
    // "No memories found" is noise the model has to read and reason about.
    const store = new VectorStore(null);
    await store.storeDocument('note', 'entirely unrelated content about typography', []);
    expect(await recallForTurn(store, 'zzzz qqqq vvvv nonsense tokens')).toBeNull();
  });

  test('respects the character budget', async () => {
    const store = new VectorStore(null);
    await store.storeDocument('big', 'permission '.repeat(2000), []);
    const recalled = await recallForTurn(store, 'tell me about the permission', { maxChars: 300 });
    expect(recalled).not.toBeNull();
    expect(recalled!.text.length).toBeLessThan(600);
  });

  test('a retrieval failure returns null instead of failing the turn', async () => {
    // Recall is an enhancement. It must never be able to break the thing it was enhancing.
    const broken = {
      semanticSearch: async () => { throw new Error('store exploded'); },
    } as unknown as VectorStore;
    await expect(recallForTurn(broken, 'a perfectly reasonable question about things')).resolves.toBeNull();
  });
});
