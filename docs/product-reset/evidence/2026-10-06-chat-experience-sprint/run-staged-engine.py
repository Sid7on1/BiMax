"""Build a fresh isolated engine; qualify transport without installing or calling a model."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent

def run(command, label, env=None):
    with (EVIDENCE / f'{label}.log').open('w') as out:
        result = subprocess.run(command, cwd=ROOT, stdout=out, stderr=subprocess.STDOUT,
                                env=env, timeout=180)
    if result.returncode:
        raise RuntimeError(f'{label} failed: {result.returncode}')

with tempfile.TemporaryDirectory(prefix='bimax-r5-engine-') as directory:
    stage = Path(directory)
    bundle = stage / 'bundle'
    run(['bun', 'build', 'src/index.ts', '--target=node', f'--outdir={bundle}'], 'engine-build')
    env = {key: value for key, value in os.environ.items()
           if not any(word in key.upper() for word in ('API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'))
           and not key.startswith(('BGW_', 'BIMAX_'))}
    env['BIMAX_BREAKGLASS_DIR'] = str(stage / 'config')
    env['BIMAX_STATE_DIR'] = str(stage / 'state')
    run([str(ROOT / 'app/node_modules/.bin/electron'), 'app/scripts/verify-engine.js',
         str(bundle / 'index.js')], 'engine-smoke', env)
    assert 'answered all 7 exchanges' in (EVIDENCE / 'engine-smoke.log').read_text()
    (EVIDENCE / 'staged-engine.json').write_text(json.dumps({
        'exchanges': 7, 'credentialsScrubbed': True, 'stateRedirected': True,
        'modelTurn': False, 'installed': False,
        'bundleSha256': hashlib.sha256((bundle / 'index.js').read_bytes()).hexdigest(),
    }, indent=2) + '\n')
