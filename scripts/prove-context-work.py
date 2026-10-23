#!/usr/bin/env python3
"""Require exact-output and work assertions to catch context optimization regressions."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'docs/product-reset/evidence/2026-10-13-context-work/mutations')
OUT = parser.parse_args().output
OUT.mkdir(parents=True, exist_ok=True)
JEST = ['node', 'node_modules/jest/bin/jest.js', '--coverage=false', '--runInBand', 'src/__tests__/context.work.sprint.test.ts']
CM = 'src/memory/context.manager.ts'
CONT = 'src/context/continuation.ts'
FAULTS = [
    ('serialize-unselectable-message', CM, "if (fields.every(field => 'value' in field && (field.value === null\n          || ['string', 'number', 'boolean', 'undefined'].includes(typeof field.value)))) return null;", 'if (false) return null;', 'does not serialize a plain message'),
    ('ignore-toJSON', CM, "&& !('toJSON' in message)", '', 'inherited toJSON hook'),
    ('ignore-proxy', CM, '&& !types.isProxy(message)', '', 'proxy keys can hide'),
    ('ignore-enumerability', CM, "content?.enumerable && 'value' in content", "content && 'value' in content", 'non-enumerable oversized'),
    ('read-content-accessor', CM, "const content = Object.getOwnPropertyDescriptor(message, 'content');", "const ignored = message.content;\n    const content = Object.getOwnPropertyDescriptor(message, 'content');", 'accessors are not read'),
    ('skip-serialization-errors', CM, "if (fields.every(field => 'value' in field && (field.value === null\n          || ['string', 'number', 'boolean', 'undefined'].includes(typeof field.value)))) return null;", 'if (true) return null;', 'other getters and serialization errors'),
    ('null-sentinel-fits', CM, 'text?.length ?? limitChars + 1', 'text?.length ?? 0', 'mixed-sized history'),
    ('eager-archive-trials', CONT, 'const handle = listHandle();', "evicted.map((text) => `- ${text}`).join('\\n');\n          const handle = listHandle();", 'constructs the evicted archive list only once'),
    ('missing-eviction-growth', CONT, 'this.evictedChars += entry.length;\n      this.evictedTotal++;', 'this.evictedTotal++;', 'evicted character accounting'),
    ('missing-eviction-subtraction', CONT, 'this.evictedChars -= dropped.length;', '// fault: retain removed characters in the total', 'evicted character accounting'),
    ('missing-adopted-characters', CONT, 'this.evictedChars += entry.length;\n          this.evictedTotal += total;', 'this.evictedTotal += total;', 'adopted archive characters'),
    ('omit-live-archive-payload', CONT, "return build(() => archive(`Earlier messages from the user, oldest first:\\n${evicted.map((text) => `- ${text}`).join('\\n')}`));", 'return build(placeholder);', 'render at'),
]
results = []
for name, relative, before, after, test in FAULTS:
    file = ROOT / relative
    original = file.read_bytes()
    source = original.decode()
    assert source.count(before) == 1, (name, source.count(before))
    try:
        file.write_text(source.replace(before, after))
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
    print(json.dumps(result), flush=True)
run = subprocess.run(JEST, cwd=ROOT, capture_output=True, text=True, timeout=40)
(OUT / 'restored-baseline.log').write_text(run.stdout + run.stderr)
(OUT / 'results.json').write_text(json.dumps({'faults': results, 'restored_exit': run.returncode}, indent=2) + '\n')
raise SystemExit(0 if run.returncode == 0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
