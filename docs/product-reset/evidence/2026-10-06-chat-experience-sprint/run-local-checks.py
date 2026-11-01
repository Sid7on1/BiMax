"""Local build/browser/transport gates plus lint compared with unchanged HEAD lines."""
import difflib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent
FILES = [
    'app/src/renderer/src/engine.requests.ts', 'app/src/renderer/src/quick.bootstrap.ts',
    'app/src/renderer/src/useEngine.ts', 'app/src/renderer/src/engine.state.ts',
    'app/src/renderer/src/markdown.tsx', 'app/src/renderer/src/components/ThreadSurfaces.tsx',
    'app/src/__tests__/chat.lifecycle.sprint.test.ts', 'app/src/__tests__/quick.bootstrap.sprint.test.ts',
]

def lint():
    result = subprocess.run(['npx', 'eslint', '--format', 'json', *FILES], cwd=ROOT,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode in (0, 1), result.stderr
    report = json.loads(result.stdout)
    (EVIDENCE / 'lint-final.json').write_text(json.dumps(report, indent=2) + '\n')
    originals = {item['filePath']: item for item in json.loads((EVIDENCE / 'lint-baseline.json').read_text())}
    existing = []
    introduced = []
    for item in report:
        file = Path(item['filePath'])
        baseline = originals.get(str(file))
        mapping = {}
        if baseline:
            original = subprocess.check_output(['git', 'show', f'HEAD:{file.relative_to(ROOT)}'], cwd=ROOT, text=True)
            old = original.splitlines()
            new = file.read_text().splitlines()
            for block in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_matching_blocks():
                mapping.update({block.b + offset + 1: block.a + offset + 1 for offset in range(block.size)})
        for message in item['messages']:
            if message['severity'] != 2:
                continue
            previous = mapping.get(message['line'])
            unchanged = baseline and any(m['severity'] == 2 and m['line'] == previous
                                        and m['ruleId'] == message['ruleId'] and m['message'] == message['message']
                                        for m in baseline['messages'])
            entry = {'file': str(file.relative_to(ROOT)), 'line': message['line'],
                     'baselineLine': previous, 'rule': message['ruleId']}
            (existing if unchanged else introduced).append(entry)
    (EVIDENCE / 'lint-scope.json').write_text(json.dumps({
        'rawExit': result.returncode, 'unchangedLegacyErrors': existing, 'introducedErrors': introduced,
        'warnings': sum(item['warningCount'] for item in report),
    }, indent=2) + '\n')
    return int(bool(introduced))

checks = [
    ('root-typecheck', ['npx', 'tsc', '--noEmit']),
    ('root-build', ['npm', 'run', 'build']),
    ('app-typecheck-final', ['npm', '--prefix', 'app', 'run', 'typecheck']),
    ('app-build', ['npm', '--prefix', 'app', 'run', 'build']),
    ('changed-lint-scope', None),
    ('browser-script-syntax', ['node', '--check', 'app/scripts/ui/chat-experience-sprint.mjs']),
    ('proof-script-syntax', ['python3', '-m', 'py_compile', 'scripts/prove-chat-experience-sprint.py',
                             str(EVIDENCE / 'run-staged-engine.py'), str(Path(__file__))]),
    ('browser-final', ['node', 'app/scripts/ui/chat-experience-sprint.mjs']),
    ('staged-engine', ['python3', str(EVIDENCE / 'run-staged-engine.py')]),
]
results = []
for label, command in checks:
    if command is None:
        code = lint()
    else:
        with (EVIDENCE / f'{label}.log').open('w') as output:
            code = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=300).returncode
    results.append({'name': label, 'command': command, 'exit': code})
    (EVIDENCE / 'checks.json').write_text(json.dumps(results, indent=2) + '\n')
    print(label, code, flush=True)
    if code:
        raise SystemExit(code)
