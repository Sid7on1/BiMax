import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../memory/vector.store';
import { recallForTurn } from '../memory/recall';
import { contentStems, stem } from '../memory/sufficiency';

/**
 * Record 50 step 7: recall abstains when memory does not know what the question is about (benchmark S5, held-out H1),
 * and still recalls when it does (T1, H2).
 */

const NOTES: Record<string, string> = {
  'office-move': 'The office moves to the third floor in May; guests sign in at reception.',
  'timeout-june': '2026-06-10 decision: the request timeout is now 60 seconds, replacing the earlier value.',
  'timeout-idle': 'The idle timeout for websocket requests is 300 seconds.',
};

let temp: string;
let stores = 0;
beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-recall-sufficiency-')); });
afterAll(() => { fs.rmSync(temp, { recursive: true, force: true }); });

async function storeWith(notes: Record<string, string>, embeddings: any = null): Promise<VectorStore> {
  const store = new VectorStore(embeddings, null, { storePath: path.join(temp, `store-${stores++}.json`), dedup: false });
  for (const [id, text] of Object.entries(notes)) await store.storeDocument(id, text, ['note']);
  return store;
}

test('a light stem joins the forms of a word, and question words are not content', () => {
  expect(['blocks', 'blocked', 'blocking', 'block'].map(stem)).toEqual(['block', 'block', 'block', 'block']);
  expect(['closes', 'guests', 'listens', 'process', 'watches'].map(stem)).toEqual(['close', 'guest', 'listen', 'process', 'watch']);
  expect(contentStems('What is the guest wifi password at the office?')).toEqual(['guest', 'wifi', 'password', 'office']);
});

test('recall injects nothing when most of the question is about something no memory mentions', async () => {
  const store = await storeWith(NOTES);
  expect(await recallForTurn(store, 'What is the guest wifi password at the office?')).toBeNull();
  // Controls: a question whose subject memory knows is recalled, even with a word memory has never seen.
  expect((await recallForTurn(store, 'What request timeout did we settle on?'))?.text).toContain('60 seconds');
  expect((await recallForTurn(store, 'Where do guests sign in at the office?'))?.text).toContain('reception');
});

test('with the dense stage on, the rule stays off: a paraphrase can match without shared words', async () => {
  const embeddings = { id: 'fixture-space', dimensions: 2, embed: async (texts: string[]) => texts.map(() => [1, 0]) };
  const store = await storeWith(NOTES, embeddings);
  const recalled = await recallForTurn(store, 'What is the guest wifi password at the office?');
  expect(store.lastSearchMode().dense).toBe(true);
  expect(recalled).not.toBeNull();
});
