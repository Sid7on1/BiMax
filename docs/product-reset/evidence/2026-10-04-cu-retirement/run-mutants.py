"""Controlled retirement faults; restore each source even when a test/tool fails."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
mutants = [
    ('governor-reenabled', 'src/governor/governor.ts',
     "if (taskType === 'COMPUTER_CONTROL') {", "if (false) {",
     'src/__tests__/computer.retirement.test.ts'),
    ('flags-reenabled', 'app/src/main/coding.runtime.paths.ts',
     ']) delete env[variable];', ']) void variable;',
     'app/src/__tests__/computer.retirement.test.ts'),
    ('shell-fallback-reenabled', 'src/tools/gui.automation.guard.ts',
     "const text = String(command || '');", "return { refused: false };\n  const text = String(command || '');",
     'src/__tests__/gui.automation.guard.test.ts'),
    ('host-call-falsely-succeeds', 'src/protocol/host.ts',
     "resolve({ ok: false, error: 'Computer Use has been removed from Bimax.' });", 'resolve({ ok: true });',
     'src/__tests__/host.handlers.test.ts'),
    ('app-host-falsely-succeeds', 'app/src/main/thread.manager.ts',
     "{ t: 'host_result', id: msg.id, ok: false,", "{ t: 'host_result', id: msg.id, ok: true,",
     'app/src/__tests__/computer.retirement.test.ts'),
]
results = []
for name, file, before, after, suite in mutants:
    target = ROOT / file
    original = target.read_text()
    assert original.count(before) == 1, name
    try:
        target.write_text(original.replace(before, after))
        result = subprocess.run(['npx', 'jest', '--runInBand', '--coverage=false', '--runTestsByPath', suite],
                                cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        (OUT / (name + '.log')).write_text(result.stdout)
        # A diagnostic/compile failure is not a caught behavior regression.
        caught = result.returncode != 0 and 'Test Suites:' in result.stdout and 'expect(' in result.stdout
        results.append({'mutant': name, 'suite': suite, 'exit': result.returncode, 'caught': caught})
        print(name, 'caught' if caught else 'FAILED', flush=True)
    finally:
        target.write_text(original)
(OUT / 'mutants.json').write_text(json.dumps(results, indent=2) + '\n')
assert all(row['caught'] for row in results), results
