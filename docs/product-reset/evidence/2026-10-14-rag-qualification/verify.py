from pathlib import Path
import datetime
import json
import os
import subprocess
import tempfile
import time

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
COMMANDS = [
    ('focused', ['node', 'node_modules/jest/bin/jest.js', '--coverage=false', '--runInBand', 'src/__tests__/rag.sprint.test.ts', 'src/__tests__/rag.resources.test.ts', 'src/__tests__/memory.store.features.test.ts', 'src/__tests__/context.recall.sufficiency.test.ts', 'src/__tests__/context.orchestration.sprint.test.ts', 'src/__tests__/sqlite.persistence.test.ts', 'src/__tests__/code.search.tool.test.ts']),
    ('rag-grader', ['node', '--test', 'scripts/rag-fixture-grader.test.cjs']),
    ('public-grader', ['python3', 'scripts/rag-public-grader.test.py']),
    ('build', ['npm', 'run', 'build']),
    ('app-typecheck', ['npm', '--prefix', 'app', 'run', 'typecheck']),
    ('lint', ['npm', 'run', 'lint']),
    ('full-jest', ['node', 'node_modules/jest/bin/jest.js', '--coverage=false', '--maxWorkers=2']),
    ('full-bun', ['npm', 'run', 'test:bun']),
    ('context-bun', ['npm', 'run', 'test:context']),
    ('node-scripts', ['npm', 'run', 'test:scripts']),
    ('app-build', ['npm', '--prefix', 'app', 'run', 'build']),
    ('engine-build', ['npm', 'run', 'build:engine']),
    ('engine-smoke', ['npm', '--prefix', 'app', 'run', 'verify:engine']),
]
results = []
with tempfile.TemporaryDirectory(prefix='bimax-rag-verification-') as temp:
    for name, command in COMMANDS:
        # Tests intentionally change cwd per fixture. A global state root overrides those paths
        # and makes unrelated fixtures share their stores. Jest already isolates secrets per worker.
        env = dict(os.environ)
        env.pop('BIMAX_STATE_DIR', None)
        env.pop('BIMAX_BREAKGLASS_DIR', None)
        if 'node_modules/jest/bin/jest.js' not in command:
            env['BIMAX_BREAKGLASS_DIR'] = temp + '/' + name + '/breakglass'
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        start = time.monotonic()
        with (OUT / f'{name}.log').open('w') as log:
            run = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        result = {'name': name, 'command': command, 'started': started, 'seconds': time.monotonic() - start, 'exit': run.returncode, 'log': f'{name}.log'}
        results.append(result)
        (OUT / 'verification.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(result), flush=True)
raise SystemExit(0 if all(r['exit'] == 0 for r in results) else 1)
