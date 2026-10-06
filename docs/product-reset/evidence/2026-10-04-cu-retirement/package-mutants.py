"""Exercise the shipped-byte inventory gate; never mutate a signed or installed bundle."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
source = Path(sys.argv[1])
scratch = Path(tempfile.mkdtemp(prefix='bimax-retirement-artifact-'))
app = scratch / 'Bimax.app'
results = []
try:
    # Only inventory inputs are needed; signed-bundle/action checks run separately on the full app.
    for relative in ['Contents/MacOS/Bimax', 'Contents/Resources/app.asar']:
        dest = app / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.link(source / relative, dest)
    engine = app / 'Contents/Resources/engine'
    engine.mkdir(parents=True)
    for wasm in (source / 'Contents/Resources/engine').glob('*.wasm'):
        os.link(wasm, engine / wasm.name)
    target = engine / 'index.js'
    original = (source / 'Contents/Resources/engine/index.js').read_bytes()
    target.write_bytes(original)

    def check(name, expected):
        result = subprocess.run(['node', 'scripts/verify-desktop-package.mjs', str(app), 'arm64'],
                                cwd=ROOT, capture_output=True, text=True, timeout=15)
        text = result.stdout + result.stderr
        (OUT / (name + '.log')).write_text(text)
        passed = result.returncode == 0 if expected is None else result.returncode != 0 and expected in text
        results.append({'case': name, 'exit': result.returncode, 'expectedResult': passed})
        assert passed, text

    check('artifact-baseline', None)
    target.write_bytes(original + b'\nclass LookAtAppTool {}\n')
    check('artifact-cu-tool-mutant', 'retired Computer Use engine tool is packaged: LookAtAppTool')
    target.write_bytes(original)
    sdk = app / 'Contents/Resources/app.asar.unpacked/node_modules/@trycua'
    sdk.mkdir(parents=True)
    check('artifact-cu-sdk-mutant', 'retired Computer Use dependency is packaged: @trycua')
finally:
    shutil.rmtree(scratch)
    (OUT / 'package-mutants.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
