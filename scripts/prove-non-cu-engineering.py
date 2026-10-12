#!/usr/bin/env python3
"""Run bounded non-CU source faults and restore the exact starting bytes each time."""
import hashlib
import json
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path,
                    default=ROOT / 'docs/product-reset/evidence/2026-10-12-non-cu-engineering/mutations')
OUT = parser.parse_args().output
OUT.mkdir(parents=True, exist_ok=True)
JEST = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--coverage=false']
FAULTS = [
    ('stream-disposal', 'src/core/llm.adapter.ts', '      closeUnfinishedStream?.();',
     '      // fault: leave provider stream open',
     JEST + ['src/__tests__/llm.stream.disposal.sprint.test.ts']),
    ('write-replay', 'src/mcp/client.ts',
     "t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint === true",
     'false', JEST + ['src/__tests__/mcp.lifecycle.sprint.test.ts', '-t', 'commits then disconnects']),
    ('startup-child', 'src/mcp/client.ts',
     '  transport.close = () => closing ??= Promise.resolve().then(close);',
     '  transport.close = close; // fault: concurrent SDK closes do not await the same child',
     JEST + ['src/__tests__/mcp.lifecycle.sprint.test.ts', '-t', 'failed handshake']),
    ('stderr-retention', 'src/mcp/stderr.ts', 'MAX_BYTES = 64 * 1024', 'MAX_BYTES = 16 * 1024 * 1024',
     JEST + ['src/__tests__/mcp.lifecycle.sprint.test.ts', '-t', 'stderr retention']),
    ('remote-stop', 'src/mcp/tasks.ts', "  signal?.addEventListener('abort', cancelRemote, { once: true });",
     '  // fault: local Stop never reaches remote task',
     JEST + ['src/__tests__/mcp.deadline.sprint.test.ts', '-t', 'Stop during backoff']),
    ('tiff-admission', 'src/documents/extract.ts',
     "bytesRead < 8 || !['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(magic)",
     'false', JEST + ['src/__tests__/extract.tiff.sprint.test.ts', '-t', 'malformed TIFFs']),
    ('artifact-fallback', 'app/scripts/release-artifact.mjs',
     'if (!isBundle(app))', 'if (false)', ['node', '--test', 'app/scripts/release-artifact.test.mjs']),
]

results = []
for name, file, before, after, command in FAULTS:
    source = ROOT / file
    original = source.read_bytes()
    text = original.decode()
    if text.count(before) != 1:
        raise RuntimeError(f'{name}: expected exactly one source marker')
    try:
        source.write_text(text.replace(before, after))
        run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=35)
        output = run.stdout + run.stderr
        (OUT / f'{name}.log').write_text(output)
        # Timeouts and compiler/runtime failures are invalid, never an assertion kill.
        assertion = ('expect(received)' in output or 'expect(jest.fn())' in output
                     or 'ERR_ASSERTION' in output)
        invalid = ('Exceeded timeout' in output or 'Test suite failed to run' in output
                   or 'Cannot find module' in output)
        result = {'fault': name, 'exit_code': run.returncode,
                  'assertion_caught': run.returncode != 0 and assertion and not invalid}
    finally:
        source.write_bytes(original)
    result['restored_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    result['exact_restoration'] = source.read_bytes() == original
    results.append(result)
    print(json.dumps(result), flush=True)

baseline = subprocess.run(JEST + [
    'src/__tests__/llm.stream.disposal.sprint.test.ts',
    'src/__tests__/mcp.lifecycle.sprint.test.ts',
    'src/__tests__/mcp.deadline.sprint.test.ts',
    'src/__tests__/extract.tiff.sprint.test.ts',
], cwd=ROOT, capture_output=True, text=True, timeout=35)
(OUT / 'restored-baseline.log').write_text(baseline.stdout + baseline.stderr)
scripts = subprocess.run(['node', '--test', 'app/scripts/release-artifact.test.mjs'],
                         cwd=ROOT, capture_output=True, text=True, timeout=10)
(OUT / 'restored-scripts.log').write_text(scripts.stdout + scripts.stderr)
report = {'faults': results, 'restored_jest_exit': baseline.returncode, 'restored_scripts_exit': scripts.returncode}
(OUT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
sys.exit(0 if baseline.returncode == scripts.returncode == 0
         and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
