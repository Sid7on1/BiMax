"""Finalize bounded local qualification only when all retained checks actually pass."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent
ALLOWED = {
    'app/src/renderer/src/components/ThreadSurfaces.tsx', 'app/src/renderer/src/engine.state.ts',
    'app/src/renderer/src/useEngine.ts', 'app/src/renderer/src/markdown.tsx',
    'docs/product-reset/README.md', 'docs/product-reset/04_FRONTEND_PLAN.md',
    'docs/product-reset/08_ACCEPTANCE_GATES.md', 'docs/product-reset/competitive/05_GAP_REGISTER.md',
    'docs/product-reset/competitive/07_BUILD_SEQUENCE.md', 'docs/product-reset/competitive/08_SOURCE_LEDGER.md',
}

def read(name):
    return json.loads((EVIDENCE / name).read_text())

checks = read('checks.json')
assert len(checks) == 9 and all(item['exit'] == 0 for item in checks)
tests = read('jest-final-results.json')
assert tests['success'] and tests['numFailedTests'] == 0
bun = (EVIDENCE / 'bun-final.log').read_text()
assert re.search(r'\b0 fail\b', bun)
mutants = read('mutations.json')
assert len(mutants) == 28 and all(m['killed'] and m['restored'] and not m['invalid'] for m in mutants)
focused_log = (EVIDENCE / 'mutation-baseline-after.log').read_text()
focused = int(re.search(r'Tests:\s+(\d+) passed,', focused_log).group(1))
assert focused == 60
for mutant in mutants:
    assert hashlib.sha256((ROOT / mutant['source']).read_bytes()).hexdigest() == mutant['sha256']
before = read('renderer-before-memo.json')
after = read('renderer-fixed.json')
fixture_hash = hashlib.sha256((EVIDENCE / 'renderer-probe.tsx').read_bytes()).hexdigest()
assert before['fixtureHash'] == after['fixtureHash'] == fixture_hash
assert before['invalid'] is None and after['invalid'] is None and not before['problems'] and not after['problems']
assert before['afterSame'] == {'lex': 21, 'highlight': 42}
assert after['afterSame'] == {'lex': 1, 'highlight': 2}
restored = 0
unexpected = []
listing = subprocess.check_output(['git', 'ls-tree', '-rz', '--full-tree', 'HEAD'], cwd=ROOT)
for item in listing.split(b'\0'):
    if not item:
        continue
    header, name = item.split(b'\t', 1)
    mode, kind, blob = header.decode().split()
    relative = os.fsdecode(name)
    if relative in ALLOWED:
        continue
    file = ROOT / relative
    if kind != 'blob' or not os.path.lexists(file):
        unexpected.append(relative)
        continue
    data = os.fsencode(os.readlink(file)) if mode == '120000' else file.read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    executable = bool(file.stat().st_mode & 0o100) if mode != '120000' else False
    if actual != blob or (mode != '120000' and executable != (mode == '100755')):
        unexpected.append(relative)
    else:
        restored += 1
assert not unexpected, unexpected
assert subprocess.run(['git', 'diff', '--check'], cwd=ROOT, capture_output=True).returncode == 0
summary = {
    'scope': 'local renderer lifecycle and operation counts; synthetic preload, no installed/provider journey',
    'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'jestPassed': tests['numPassedTests'], 'jestSkipped': tests['numPendingTests'],
    'jestSuitesPassed': tests['numPassedTestSuites'],
    'bunPassed': int(re.search(r'(\d+) pass\b', bun).group(1)), 'bunFailed': 0,
    'focusedTests': focused, 'assertionCaughtMutants': len(mutants),
    'exactMutationSourceRestoration': True, 'unrelatedTrackedFilesUnchanged': restored,
    'unexpectedTrackedChanges': unexpected, 'checks': checks,
    'lint': read('lint-scope.json'), 'stagedEngine': read('staged-engine.json'),
    'rendering': {'fixtureSha256': fixture_hash, 'before': before['afterSame'], 'after': after['afterSame'],
                  'parentUpdates': 20, 'wallLatencyMeasured': False, 'energyMeasured': False},
    'missingResearch': [path for path in [
        'docs/product-reset/competitive/03_CAPABILITY_MATRIX.md',
        'docs/product-reset/competitive/examples/P01_FAST_CODE_AND_COWORK.md',
        'docs/product-reset/34_FAST_CODE_AND_COWORK_IMPLEMENTATION_RECORD.md',
    ] if not (ROOT / path).exists()],
}
(EVIDENCE / 'qualification-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
sources = [ROOT / path for path in ALLOWED] + [
    ROOT / 'app/src/renderer/src/engine.requests.ts', ROOT / 'app/src/renderer/src/quick.bootstrap.ts',
    ROOT / 'app/src/__tests__/chat.lifecycle.sprint.test.ts', ROOT / 'app/src/__tests__/quick.bootstrap.sprint.test.ts',
    ROOT / 'app/scripts/ui/chat-experience-sprint.mjs', ROOT / 'scripts/prove-chat-experience-sprint.py',
    ROOT / 'docs/product-reset/75_CHAT_EXPERIENCE_AND_RENDERING_SPRINT.md',
]
records = [path for path in EVIDENCE.rglob('*') if path.is_file() and '__pycache__' not in path.parts
           and path.name != 'sha256-manifest.json']
hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
          for path in sorted(sources + records)}
(EVIDENCE / 'sha256-manifest.json').write_text(json.dumps(hashes, indent=2) + '\n')
print(json.dumps({key: summary[key] for key in ['jestPassed', 'bunPassed', 'assertionCaughtMutants', 'unrelatedTrackedFilesUnchanged']}))
