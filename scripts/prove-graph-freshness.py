#!/usr/bin/env python3
"""Assert bounded graph-source faults are detected; restore exact source bytes every time."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, default=ROOT / 'docs/product-reset/evidence/2026-10-13-graph-freshness/mutations')
OUT = p.parse_args().output
OUT.mkdir(parents=True, exist_ok=True)
JEST = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--coverage=false', 'src/__tests__/graph.freshness.sprint.test.ts']
FAULTS = [
 ('ctime-fast-path', 'src/graph/sqlite.graph.store.ts', 'r.ctime !== null && st.ctimeMs === Number(r.ctime) && ', '', 'same-size edit'),
 ('file-substring-removal', 'src/graph/sqlite.graph.store.ts', 'np === rel || id === `file:${rel}`', 'np === rel || id.includes(`:${rel}`)', 'per-file deletion'),
 ('incoming-edges', 'src/graph/file.graph.ts', '|| replacement.nodes.has(edge.targetId)', '', 'incoming calls'),
 ('missing-parse-input', 'src/graph/static.analyzer.ts', 'throw new Error(`Could not find source file in TS Program: ${absolutePath}`);', 'return;', 'unavailable parse input'),
 ('failed-hash-adoption', 'src/graph/indexer.ts', 'store.recordFileHashes(this.projectRoot, refreshed, parsedStates, deleted);', 'store.recordFileHashes(this.projectRoot, changed);', 'failed refresh'),
 ('parse-race-fence', 'src/graph/sqlite.graph.store.ts', 'if (!st || !parsed || st.hash !== parsed.hash || st.mtimeMs !== parsed.mtimeMs || st.ctimeMs !== parsed.ctimeMs || st.size !== parsed.size) continue;', 'if (false) continue;', 'edited again'),
 ('graph-revision', 'src/graph/pagerank.ts', '&& entry.revision === revision ', '', 'republishing'),
 ('outline-key', 'src/graph/pagerank.ts', 'JSON.stringify([String(maxTokens), focusTerms, headerLabel ?? null])', "`${maxTokens}:${focusTerms.join(',')}:${headerLabel || ''}`", 'outline keys'),
 ('new-file-discovery', 'src/graph/indexer.ts', 'for (const abs of candidates)', 'for (const abs of candidates.slice(0, 0))', 'rename'),
 ('failed-commit', 'src/graph/sqlite.graph.store.ts', 'throw e; // callers must not advance hash baselines after a failed graph commit', '// fault: hide failed commit', 'failed SQLite commit'),
 ('non-ts-parser-admission', 'src/graph/indexer.ts', "if (!await tsa.analyzeSingleFile(abs)) throw new Error('No parser or grammar available for source.');", 'await tsa.analyzeSingleFile(abs);', 'unavailable non-TS grammar'),
 ('batch-program-reuse', 'src/graph/indexer.ts', 'this.analyzer.analyzeSingleFile(abs, snapshot);', 'this.analyzer.analyzeSingleFile(abs);', 'one compiler snapshot'),
 ('deletion-hash-before-commit', 'src/graph/indexer.ts', 'store.removeFileNodes(rel, true)', 'store.removeFileNodes(rel)', 'failed deletion commit'),
 ('cached-ranking-enumeration', 'src/graph/pagerank.ts', 'if (hit) return hit;', 'if (hit) { Array.from(graph.nodes.values()); return hit; }', 'does not enumerate'),
]
results = []
for name, rel, before, after, test in FAULTS:
    file = ROOT / rel
    original = file.read_bytes()
    source = original.decode()
    if source.count(before) != 1:
        raise RuntimeError(f'{name}: expected one source marker, found {source.count(before)}')
    try:
        file.write_text(source.replace(before, after))
        run = subprocess.run(JEST + ['-t', test], cwd=ROOT, capture_output=True, text=True, timeout=45)
        log = run.stdout + run.stderr
        (OUT / f'{name}.log').write_text(log)
        assertion = 'expect(received)' in log or 'expect(jest.fn())' in log
        invalid = any(marker in log for marker in ['Test suite failed to run', 'Exceeded timeout', 'Cannot find module', 'FATAL ERROR'])
        result = {'fault': name, 'exit_code': run.returncode, 'assertion_caught': run.returncode != 0 and assertion and not invalid}
    finally:
        file.write_bytes(original)
    result.update(exact_restoration=file.read_bytes() == original, restored_sha256=hashlib.sha256(file.read_bytes()).hexdigest())
    results.append(result)
    print(json.dumps(result), flush=True)
run = subprocess.run(JEST, cwd=ROOT, capture_output=True, text=True, timeout=45)
(OUT / 'restored-baseline.log').write_text(run.stdout + run.stderr)
(OUT / 'results.json').write_text(json.dumps({'faults': results, 'restored_exit': run.returncode}, indent=2) + '\n')
raise SystemExit(0 if run.returncode == 0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
