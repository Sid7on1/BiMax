#!/usr/bin/env python3
"""Apply real RAG source faults; require assertion failures and exact restoration."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'docs/product-reset/evidence/2026-10-14-rag-qualification/mutations-final')
OUT = parser.parse_args().output
OUT.mkdir(parents=True, exist_ok=True)
JEST = ['node', 'node_modules/jest/bin/jest.js', '--coverage=false', '--runInBand', 'src/__tests__/rag.sprint.test.ts', 'src/__tests__/rag.resources.test.ts']
STORE, RECALL = 'src/memory/vector.store.ts', 'src/memory/recall.ts'
FAULTS = [
    ('omit-document-backfill', STORE, [('for (const candidate of fusedCandidates.backfill)', 'for (const candidate of fusedCandidates.backfill.slice(0, 0))')], 'lexical does not'),
    ('omit-dense-champions', STORE, [('denseDocuments = documents.sorted().map(s => s.id);', 'denseDocuments = [];')], 'dense does not'),
    ('omit-lexical-champions', STORE, [('lexicalDocuments.push(hit.id);', '// fault: no lexical champions')], 'lexical does not'),
    ('ignore-backfill-floor', STORE, [
        ('if (minScore > 0 && lexicalRelevance(query, chunk.text) < minScore) continue;', 'if (false) continue;'),
        ('if (matched.has(candidate.doc.id)) continue;\n        if (!candidate.fromDense && minScore > 0 && lexicalRelevance(query, candidate.text) < minScore) continue;', 'if (matched.has(candidate.doc.id)) continue;\n        if (false) continue;')], 'backfill does not bypass'),
    ('ignore-document-scope', STORE, [('const lexicalHits = mode === \'dense\' ? [] : this.index.search(query).filter(h => allowed(h.id));', "const lexicalHits = mode === 'dense' ? [] : this.index.search(query);")], 'backfilled evidence obeys'),
    ('reorder-winning-prefix', STORE, [('matched.set(candidate.doc.id, [candidate.chunk]);\n        results.push(candidate.doc);', 'matched.set(candidate.doc.id, [candidate.chunk]);\n        results.unshift(candidate.doc);')], 'smaller document result limit'),
    ('expand-remote-rerank-pool', STORE, [('let ordered = fusedCandidates.candidates;', 'let ordered = [...fusedCandidates.candidates, ...fusedCandidates.backfill];')], 'bounded reranking'),
    ('restore-chunk-rescans', STORE, [('return doc.chunks?.[typeof address', 'doc.chunks?.find(chunk => chunk === doc.chunks![0]);\n    return doc.chunks?.[typeof address')], 'candidate resolution'),
    ('scan-entire-vocabulary', STORE, [('for (const term of remaining) if (cached.stems.has(term)) remaining.delete(term);', 'for (const term of cached.stems) remaining.delete(term);')], 'unknown-term checks probe'),
    ('copy-recency-before-identity-check', STORE, [('if (identity === this.diskIdentity) return;\n        const pendingRecency', 'const pendingRecency'), ('const data = await fs.readFile(this.STORE_PATH, \'utf-8\');', "if (identity === this.diskIdentity) return;\n        const data = await fs.readFile(this.STORE_PATH, 'utf-8');")], 'unchanged-file warm'),
    ('spend-all-on-first-source', RECALL, [('budget - later * reservePerSource, query', 'budget, query')], 'long first source leaves room'),
    ('reserve-too-much-for-tiny-budget', RECALL, [('Math.max(0, Math.floor((budget - reservePerSource) / reservePerSource))', 'documents.length')], 'tiny prompt budget'),
    ('always-build-diversity-pool', STORE, [('if (eligible.size >= limit) return', 'if (false) return')], 'ordinary dense search'),
    ('retain-per-chunk-containers', STORE, [('Number.isSafeInteger(address) ? address : [docAt, chunkAt]', '[docAt, chunkAt]')], 'normal chunk lookup retains'),
    ('rescore-crowding-document', STORE, [('let best = known.get(doc);', 'let best: DenseCandidate | undefined;')], 'crowding backfill reuses'),
    ('ignore-duplicate-owner-ambiguity', STORE, [('if (!this.duplicateChunkOwners) for (const candidate of denseScored)', 'for (const candidate of denseScored)')], 'duplicate chunk IDs retain'),
    ('wrong-position-width', STORE, [('const address = chunkAt * width + docAt;', 'const address = chunkAt + docAt;')], 'zero addresses and positions'),
    ('lose-address-zero', STORE, [('return address === undefined ? undefined : this.store[typeof address', 'return !address ? undefined : this.store[typeof address')], 'zero addresses and positions'),

    ('ignore-cached-recency', STORE, [('|| b.recency - a.recency', '|| 0')], 'cached dense tie recency'),
]
results = []
for name, relative, changes, test in FAULTS:
    file = ROOT / relative
    original = file.read_bytes()
    source = original.decode()
    for before, after in changes:
        assert source.count(before) == 1, (name, before, source.count(before))
        source = source.replace(before, after)
    try:
        file.write_text(source)
        run = subprocess.run(JEST + ['-t', test], cwd=ROOT, capture_output=True, text=True, timeout=40)
        log = run.stdout + run.stderr
        (OUT / f'{name}.log').write_text(log)
        assertion = 'expect(received)' in log or 'expect(jest.fn())' in log
        invalid = any(s in log for s in ['Test suite failed to run', 'Exceeded timeout', 'Cannot find module', 'FATAL ERROR'])
        result = {'fault': name, 'source': relative, 'exit': run.returncode, 'assertion_caught': run.returncode != 0 and assertion and not invalid}
    finally:
        file.write_bytes(original)
    result.update(exact_restoration=file.read_bytes() == original, restored_sha256=hashlib.sha256(original).hexdigest())
    results.append(result)
    (OUT / 'progress.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(result), flush=True)
run = subprocess.run(JEST, cwd=ROOT, capture_output=True, text=True, timeout=40)
(OUT / 'restored.log').write_text(run.stdout + run.stderr)
(OUT / 'results.json').write_text(json.dumps({'faults': results, 'restored_exit': run.returncode}, indent=2) + '\n')
raise SystemExit(0 if run.returncode == 0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
