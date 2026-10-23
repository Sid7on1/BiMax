const { createHash } = require('crypto');

// Independent observations: corpus bytes, actual returned IDs and actual prompt evidence.
// Expected answers stay outside the ingested corpus/query metadata.
function gradeEvidence({ docs, retrieved, recalled, expected, facts, forbidden, maxChars }) {
  const ids = retrieved.map(doc => doc.id), expectedSet = new Set(expected);
  const found = new Set(ids.filter(id => expectedSet.has(id))).size;
  const rank = ids.findIndex(id => expectedSet.has(id));
  const text = recalled?.text ?? '';
  const promptChars = text.split('\n').slice(1).join('\n').length;
  const provenance = !!recalled?.evidence.length && recalled.evidence.every(span => {
    const doc = docs.find(doc => `memory:${doc.id}` === span.sourceId);
    return doc && span.text && text.includes(span.text) && doc.metadata.content.includes(span.text)
      && span.sourceVersion === `sha256:${createHash('sha256').update(doc.metadata.content).digest('hex')}`
      && span.locator.documentId === doc.id && recalled.ids.includes(doc.id);
  });
  const scopeViolation = ids.some(id => forbidden.ids.includes(id)) || forbidden.text.some(value => text.includes(value));
  return { ids, recallAt3: found / expected.length, complete: found === expected.length,
    reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
    precision: ids.length ? ids.filter(id => expectedSet.has(id)).length / ids.length : 0,
    promptFactCoverage: facts.filter(fact => text.includes(fact)).length / facts.length,
    promptComplete: facts.every(fact => text.includes(fact)), scopeViolation, provenance, promptChars,
    budgetValid: promptChars <= maxChars };
}
function passes(row) { return row.complete && row.promptComplete && !row.scopeViolation && row.provenance && row.budgetValid; }
module.exports = { gradeEvidence, passes };
