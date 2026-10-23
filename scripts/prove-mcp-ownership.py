#!/usr/bin/env python3
"""Inject bounded MCP ownership faults sequentially; restore exact source even on failure.

Run only when builds/tests are idle. These are assertion checks, not reliability percentages.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/product-reset/evidence/2026-10-12-mcp-ownership/mutations'
JEST = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--coverage=false']
TEST = 'src/__tests__/mcp.ownership.sprint.test.ts'
PROCESS = 'src/__tests__/mcp.ownership.process.test.ts'
FAULTS = [
    ('resource-stop', 'src/mcp/client.ts',
     '    return context?.signal ? AbortSignal.any([lifetime.signal, context.signal]) : lifetime.signal;',
     '    return lifetime.signal; // fault: ignore caller Stop', TEST, 'Stop aborts resource reads'),
    ('resource-budget', 'src/mcp/resources.ts',
     'return withRequestDeadline(budget, signalFor(context),',
     'return withRequestDeadline(budget * 10, signalFor(context),', TEST, 'one total deadline'),
    ('catalog-owner', 'src/mcp/tool.catalog.ts',
     'if (this.registry.getTool(name) === tool) this.registry.unregister(name);',
     'if (true) this.registry.unregister(name);', TEST, 'only tool objects owned'),
    ('catalog-coalescing', 'src/mcp/client.ts', '      if (refreshing) return refreshing;',
     '      // fault: start a parallel catalog read per notification', TEST, 'notifications coalesce'),
    ('connection-retirement', 'src/mcp/client.ts',
     '    lifetime.abort(new Error(`MCP \'${spec.name}\' connection retired.`));',
     '    // fault: stale tools and replies remain active', TEST, 'late catalog refresh'),
    ('stale-health', 'src/mcp/manager.ts',
     '      } catch (e: any) {\n        if (this.connections.get(conn.name) !== conn) continue;',
     '      } catch (e: any) {\n        // fault: health reply may belong to an old connection', TEST, 'stale health failure'),
    ('resource-only', 'src/mcp/client.ts', 'const listed = caps?.tools ? await',
     'const listed = true ? await', TEST, 'resource-only server connects'),
    ('initial-notification', 'src/mcp/client.ts', '      dirty = true;',
     '      dirty = !initializing;', TEST, 'notification during initial catalog'),
    ('watchdog-generation', 'src/mcp/manager.ts',
     'const current = () => this.watchdogGeneration === generation && this.watchdog !== null;',
     'const current = () => this.watchdog !== null;', TEST, 'stopped watchdog sweep'),
    ('transport-close', 'src/mcp/client.ts',
     '  transport.close = () => closing ??= Promise.resolve().then(close);',
     '  transport.close = close;', 'src/__tests__/mcp.lifecycle.sprint.test.ts', 'failed handshake'),
    ('pending-cleanup', 'src/mcp/manager.ts',
     '    if (attempt) await this.pendingFinished.get(attempt);',
     '    // fault: disconnect returns before its pending child closes', PROCESS, 'real catalog discovery'),
]

def run(command, receipt, timeout=45):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    output = result.stdout + result.stderr
    (OUT / receipt).write_text(output)
    return result, output


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    baseline, _ = run(JEST + [TEST, PROCESS], 'before-faults.log')
    if baseline.returncode != 0:
        raise RuntimeError('Baseline must pass before injecting source faults.')
    results = []
    for name, file, before, after, test, title in FAULTS:
        source = ROOT / file
        original = source.read_bytes()
        text = original.decode()
        if text.count(before) != 1:
            raise RuntimeError(f'{name}: expected one source marker')
        try:
            source.write_text(text.replace(before, after))
            result, output = run(JEST + [test, '-t', title], f'{name}.log')
            assertion = ('expect(received)' in output or 'expect(jest.fn())' in output)
            invalid = any(marker in output for marker in [
                'Exceeded timeout', 'Test suite failed to run', 'Cannot find module',
            ])
            receipt = {'fault': name, 'exit_code': result.returncode,
                       'assertion_caught': result.returncode != 0 and assertion and not invalid}
        finally:
            source.write_bytes(original)
        receipt['exact_restoration'] = source.read_bytes() == original
        receipt['restored_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
        results.append(receipt)
        print(json.dumps(receipt), flush=True)
    restored, _ = run(JEST + [TEST, PROCESS], 'restored.log')
    report = {'baseline_exit': baseline.returncode, 'faults': results, 'restored_exit': restored.returncode}
    (OUT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0 if restored.returncode == 0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1


if __name__ == '__main__':
    sys.exit(main())
