import { answeringExcerpt, recallForTurn } from '../memory/recall';
import { versionOfText } from '../context/evidence';
import type { VectorDocument, VectorStore } from '../memory/vector.store';

function document(id: string, bodies: string[], header = ''): VectorDocument {
  const chunks = bodies.map((text, i) => ({ id: `${id}#${i}`, text }));
  return { id, metadata: { content: [header, ...bodies].filter(Boolean).join('\n'), tags: [] }, chunks, matchedChunks: chunks };
}
const seam = (docs: VectorDocument[]) => ({ semanticSearch: async () => docs }) as unknown as VectorStore;

test('an oversized single line keeps the answering clause near its end', () => {
  const text = `${'Routine unrelated logistics detail. '.repeat(100)}The indigo launch code is KESTREL-83. Please keep the complete code.`;
  const shown = answeringExcerpt(text, 'What is the indigo launch code?', 160);
  expect(shown).toContain('indigo launch code is KESTREL-83');
  expect(shown.length).toBeLessThanOrEqual(160);
  expect(text).toContain(shown);
});

test('whole-word matching and Unicode cannot select a substring decoy', () => {
  const text = `${'A codependence discussion has no answer. '.repeat(100)}नील कमल पासवर्ड = VIOLET-28. This is the saved password.`;
  const shown = answeringExcerpt(text, 'नील कमल पासवर्ड', 120);
  expect(shown).toContain('VIOLET-28'); expect(text).toContain(shown);
});

test('three long sources each retain an independently required fact at the same total budget', async () => {
  const docs = ['crane', 'ibis', 'tern'].map((name, i) => document(name, [
    `${name} maintenance history ${'ordinary background '.repeat(100)}. ${name} launch credential is BIRD-${i + 81}.`,
  ]));
  const result = (await recallForTurn(seam(docs), 'What are the crane, ibis and tern launch credentials?', { maxChars: 1800 }))!;
  for (const fact of ['BIRD-81', 'BIRD-82', 'BIRD-83']) expect(result.text).toContain(fact);
  expect(result.ids).toEqual(['crane', 'ibis', 'tern']);
  expect(result.text.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(1800);
  for (const span of result.evidence) expect(result.text).toContain(span.text);
});

test('one long source keeps evidence from multiple matching chunks, in source order', async () => {
  const doc = document('course', ['copper', 'silver', 'gold'].map((name, i) =>
    `The ${name} course attendance total is ${23 + i}. ${'Background course administration. '.repeat(45)}`));
  doc.matchedChunks = [doc.chunks![2], doc.chunks![0], doc.chunks![1]];
  const result = (await recallForTurn(seam([doc]), 'What were the copper, silver and gold course attendance totals?', { maxChars: 900 }))!;
  for (const count of ['23', '24', '25']) expect(result.text).toContain(count);
  expect(result.text.indexOf('copper')).toBeLessThan(result.text.indexOf('silver'));
  expect(result.text.indexOf('silver')).toBeLessThan(result.text.indexOf('gold'));
  for (const span of result.evidence) {
    expect(result.text).toContain(span.text); expect(doc.metadata.content).toContain(span.text);
    expect(span.sourceVersion).toBe(versionOfText(doc.metadata.content));
  }
});

test('a dated source header survives a match from a later chunk as separately shown evidence', async () => {
  const doc = document('visit', ['user: I visited the observatory yesterday.'], 'Session date: 2026/04/17 (Fri) 12:30');
  const result = (await recallForTurn(seam([doc]), 'On which date did I visit the observatory?', { maxChars: 500 }))!;
  expect(result.text).toContain('Session date: 2026/04/17 (Fri) 12:30');
  expect(result.text).toContain('visited the observatory yesterday');
  expect(result.evidence.some(span => span.text.includes('Session date:'))).toBe(true);
  expect(result.evidence.every(span => span.validFrom === undefined)).toBe(true);
  expect(result.evidence.every(span => doc.metadata.content.includes(span.text))).toBe(true);
});

test('retrieval recency never becomes a fact date, and tiny budgets retain exact partial provenance', async () => {
  const doc = { ...document('plain', ['marigold '.repeat(100)]), lastUsedAt: 1780000000000 };
  const result = (await recallForTurn(seam([doc]), 'marigold', { maxChars: 100 }))!;
  expect(result.text).not.toContain('1780000000000');
  expect(result.evidence[0].locator).toMatchObject({ partial: true });
  expect(result.text).toContain(result.evidence[0].text);
});

test('unmatched queries keep the head and short notes remain complete', async () => {
  const text = 'A short ordinary passage. '.repeat(40);
  expect(answeringExcerpt(text, 'zebra quokka', 100)).toBe(text.slice(0, 100).trimEnd());
  const note = document('small', ['The amber retry limit is 8.']);
  expect((await recallForTurn(seam([note]), 'amber retry limit'))?.text).toContain(note.metadata.content);
});

test('duplicate matching text preserves its first ranked chunk locator', async () => {
  const doc = document('duplicate', ['The cyan launch token is LARK-19.', 'The cyan launch token is LARK-19.']);
  const result = (await recallForTurn(seam([doc]), 'cyan launch token'))!;
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0].locator).toMatchObject({ part: 1, parts: 2 });
});

test('a lower-ranked source has room for a complete multi-part constraint', async () => {
  const tail = `The pelican credential procedure is ID-P61, then ${'read the independent instruction carefully '.repeat(5)} TOKEN-P62, and finally CHECK-P63.`;
  const docs = [document('first', ['Routine launch reference. '.repeat(100)]),
    document('second', [`${'Unrelated historical details. '.repeat(100)}${tail}`])];
  const result = (await recallForTurn(seam(docs), 'What is the pelican credential procedure?', { maxChars: 1800 }))!;
  for (const fact of ['ID-P61', 'TOKEN-P62', 'CHECK-P63']) expect(result.text).toContain(fact);
});

test('the default allowance keeps complete short matched chunks while remaining bounded', async () => {
  const doc = document('complete', ['violet', 'scarlet', 'ochre'].map(name => `${name} ${'precise operational details '.repeat(32)}`.trimEnd()));
  const result = (await recallForTurn(seam([doc]), 'violet scarlet ochre operational details'))!;
  for (const chunk of doc.chunks!) expect(result.text).toContain(chunk.text);
  expect(result.text.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(6000);
});
