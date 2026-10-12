#!/usr/bin/env python3
"""Record 88: reject real source faults, then restore exact bytes even after failure."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/product-reset/evidence/2026-10-12-algorithm-upgrade'
JEST = ['npx', 'jest', '--coverage=false', '--runInBand', 'src/__tests__/algorithm.upgrade.test.ts', 'src/__tests__/memory.vector.store.test.ts']
BUN = ['bun', 'test', './src/__tests__/code.index.test.ts']
FAULTS = [
 ('bm25-empty-postings', 'src/memory/bm25.ts', 'this.postings.has(term)', 'false && this.postings.has(term)', JEST),
 ('bm25-stale-rebuild', 'src/memory/bm25.ts', 'this.postings = new Map();', '/* deliberately keep old postings */', JEST),
 ('bm25-wrong-idf-frequency', 'src/memory/bm25.ts', 'const df = this.postings.get(term)?.length ?? 0;', 'const df = 0;', JEST),
 ('heap-wrong-root-admission', 'src/utils/bounded.top.k.ts', 'order - worst.order) >= 0', 'order - worst.order) <= 0', JEST),
 ('heap-unstable-equal-boundary', 'src/utils/bounded.top.k.ts', 'order - worst.order) >= 0', 'worst.order - order) >= 0', JEST),
 ('breaker-wrong-cutoff', 'src/core/circuit-breaker.ts', '!.at < cutoff', '!.at <= cutoff', JEST),
 ('breaker-lost-failure-subtraction', 'src/core/circuit-breaker.ts', 'if (this.entries[this.head]!.isFailure) this.failures--;', '/* deliberately omit failure subtraction */', JEST),
 ('breaker-lost-head-advance', 'src/core/circuit-breaker.ts', 'this.head = (this.head + 1) % MAX_WINDOW_ENTRIES;', 'this.head = 0;', JEST),
 ('cache-touch-without-promotion', 'src/memory/file-state-cache.ts', 'this.cache.delete(key);\n    this.cache.set(key, entry);', 'this.cache.set(key, entry);', JEST),
 ('vector-scope-bypass', 'src/memory/vector.store.ts', 'if (!docAllowed(doc)) continue;', '/* deliberately ignore scope */', JEST),
 ('sqlite-scope-bypass', 'src/memory/sqlite.code.store.ts', 'if (!allowed(id)) continue;', '/* deliberately ignore scope */', BUN),
 ('sqlite-relative-floor-removed', 'src/memory/sqlite.code.store.ts', 'Math.max(this.minDenseScore, (best[0]?.score ?? 0) - 0.05)', 'this.minDenseScore', BUN),
]

def digest(data):
 return hashlib.sha256(data).hexdigest()

def run(command, name):
 result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
 output = result.stdout + result.stderr
 (EVIDENCE / (name + '.log')).write_text(output)
 return result.returncode, output

report = {'schema': 1, 'faults': []}
for command, name in [(JEST, 'mutation-clean-before-jest'), (BUN, 'mutation-clean-before-bun')]:
 code, output = run(command, name)
 if code:
  sys.exit('Clean baseline failed: ' + name)
for name, file, old, new, command in FAULTS:
 p = ROOT / file
 original = p.read_bytes()
 source = original.decode()
 if source.count(old) != 1:
  sys.exit(f'{name}: expected one replacement, got {source.count(old)}')
 try:
  p.write_text(source.replace(old, new, 1))
  code, output = run(command, 'mutant-' + name)
  # A crash, transform/type error or missing executable is not an assertion-caught mutant.
  assertion = ('Expected:' in output or 'expect(received)' in output) and 'TS2322' not in output and 'Test suite failed to run' not in output
  rejected = code != 0 and assertion
  report['faults'].append({'name': name, 'file': file, 'exit_code': code, 'assertion_caught': rejected, 'restored_sha256': digest(original)})
 finally:
  p.write_bytes(original)
  assert digest(p.read_bytes()) == digest(original)
 (EVIDENCE / 'mutations.json').write_text(json.dumps(report, indent=2) + '\n')
 print(name + ': ' + ('assertion caught' if rejected else 'NOT PROVEN'), flush=True)
 if not rejected:
  sys.exit(1)
for command, name in [(JEST, 'mutation-clean-after-jest'), (BUN, 'mutation-clean-after-bun')]:
 code, output = run(command, name)
 if code:
  sys.exit('Restored baseline failed: ' + name)
report['restored_baselines_pass'] = True
(EVIDENCE / 'mutations.json').write_text(json.dumps(report, indent=2) + '\n')
