const { test } = require('node:test'), assert = require('node:assert/strict'), { createHash } = require('crypto');
const { gradeEvidence, passes } = require('./lib/rag-fixture-grader.cjs');
function fixture() {
  const content = 'quartz CHECKSUM42';
  return { docs: [{ id: 'checksum', metadata: { content } }], retrieved: [{ id: 'checksum' }],
    recalled: { ids: ['checksum'], text: `header\n- ${content}`, evidence: [{ sourceId: 'memory:checksum',
      sourceVersion: `sha256:${createHash('sha256').update(content).digest('hex')}`, text: content, locator: { documentId: 'checksum' } }] },
    expected: ['checksum'], facts: ['CHECKSUM42'], forbidden: { ids: ['private'], text: ['FORBIDDEN'] }, maxChars: 100 };
}
test('exact independently observed evidence passes', () => assert.equal(passes(gradeEvidence(fixture())), true));
for (const [name, mutate] of [
  ['missing required document', f => { f.retrieved = []; }],
  ['duplicate document cannot replace another required source', f => { f.expected.push('approval'); f.retrieved.push(f.retrieved[0]); }],
  ['fact absent from prompt', f => { f.recalled.text = 'header\n- quartz'; }],
  ['invented evidence', f => { f.recalled.evidence[0].text = 'unobserved'; }],
  ['stale source version', f => { f.recalled.evidence[0].sourceVersion = 'sha256:stale'; }],
  ['wrong source', f => { f.recalled.evidence[0].sourceId = 'memory:unknown'; }],
  ['wrong locator', f => { f.recalled.evidence[0].locator.documentId = 'other'; }],
  ['scope violation in results', f => { f.retrieved.push({ id: 'private' }); }],
  ['scope violation in prompt', f => { f.recalled.text += ' FORBIDDEN'; }],
  ['budget overflow', f => { f.maxChars = 5; }],
]) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.equal(passes(gradeEvidence(f)), false); });
