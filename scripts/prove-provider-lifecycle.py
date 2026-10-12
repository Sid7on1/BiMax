#!/usr/bin/env python3
"""Sequential provider source faults, assertion checks, and exact-byte restoration.
Run with other tests/builds idle. Local fixtures do not qualify a hosted provider.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/product-reset/evidence/2026-10-12-provider-lifecycle/mutations'
JEST = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--coverage=false']
TEST = 'src/__tests__/provider.lifecycle.sprint.test.ts'
HTTP = 'src/__tests__/provider.lifecycle.http.test.ts'
FAULTS = [
    ('primary-lookup-wait', 'src/core/hedged.request.ts',
     'entry.leg.promise.then(value => {', 'entry.leg.promise.then(async value => { await options.nextKey();',
     'primary headers return'),
    ('header-deadline', 'src/core/hedged.request.ts',
     'setTimeout(() => expire(), Math.max(0, options.budgetMs))', 'setTimeout(() => expire(), Math.max(0, options.budgetMs * 10))',
     'hedging disabled still bounds'),
    ('header-stop', 'src/core/hedged.request.ts',
     "    options.signal?.addEventListener('abort', stop, { once: true });", '    // fault: ignore Stop while headers are pending',
     'Stop bounds uncooperative header'),
    ('key-wait-stop', 'src/core/llm.adapter.ts',
     'acquire({\n      signal,', 'acquire({', 'Stop interrupts rate-limit waiting'),
    ('chunk-stop', 'src/core/llm.adapter.ts',
     '}, () => (stream as any)?.controller?.abort?.(), options.signal);', '}, () => (stream as any)?.controller?.abort?.());',
     'Stop interrupts an uncooperative chunk'),
    ('cancel-key-health', 'src/core/llm.adapter.ts',
     'if (isUserAbort(e, options.signal)) {', 'if (false) {', 'cancelled streaming is neutral'),
    ('final-tool-stop', 'src/core/llm.adapter.ts',
     'for (const event of reader.finish()) {\n        options.signal?.throwIfAborted();', 'for (const event of reader.finish()) {',
     'Stop between finalized tool calls'),
    ('header-listener-cleanup', 'src/core/hedged.request.ts',
     "      options.signal?.removeEventListener('abort', stop);", '      // fault: retain Stop listener',
     'successful headers release'),
    ('setup-stop-cleanup', 'src/core/hedged.request.ts',
     '      if (settled) abortLeg(entry);', '      // fault: setup returned after Stop without cleanup',
     'Stop during synchronous request setup'),
    ('backup-setup-failure', 'src/core/hedged.request.ts',
     'catch (error) { failed(error); return; }', 'catch (error) { fail(error, true); return; }',
     'synchronous backup launch failure'),
    ('deadline-failure-classification', 'src/core/hedged.request.ts',
     '        if (now() >= deadline) { expire(); return; }\n        entry.failed = true;', '        entry.failed = true;',
     'connection error arriving at the absolute deadline'),
]


def run(command, log):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=45)
    output = result.stdout + result.stderr
    (OUT / log).write_text(output)
    return result.returncode, output


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    code, _ = run(JEST + [TEST, HTTP], 'baseline.log')
    if code:
        raise RuntimeError('Baseline must pass before fault injection')
    receipts = []
    for name, file, before, after, title in FAULTS:
        path = ROOT / file
        original = path.read_bytes()
        source = original.decode()
        if source.count(before) != 1:
            raise RuntimeError(f'{name}: expected one source marker')
        try:
            path.write_text(source.replace(before, after))
            code, output = run(JEST + [TEST, '-t', title], name + '.log')
            assertion = 'expect(received)' in output or 'expect(jest.fn())' in output
            invalid = any(marker in output for marker in ['Exceeded timeout', 'Test suite failed to run', 'Cannot find module'])
            receipt = {'fault': name, 'exit_code': code, 'assertion_caught': code != 0 and assertion and not invalid}
        finally:
            path.write_bytes(original)
        receipt.update(exact_restoration=path.read_bytes() == original, restored_sha256=hashlib.sha256(original).hexdigest())
        receipts.append(receipt)
        print(json.dumps(receipt), flush=True)
        (OUT / 'receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
        if not receipt['assertion_caught'] or not receipt['exact_restoration']:
            raise RuntimeError(f'{name}: no valid assertion kill')
    code, _ = run(JEST + [TEST, HTTP], 'restored.log')
    (OUT / 'result.json').write_text(json.dumps({'faults': len(receipts), 'restored_baseline_exit': code}, indent=2) + '\n')
    if code:
        raise RuntimeError('Restored baseline failed')


if __name__ == '__main__':
    main()
