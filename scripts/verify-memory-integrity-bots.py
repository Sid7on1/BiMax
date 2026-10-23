#!/usr/bin/env python3
"""Sequential local qualification. Avoid overlapping compilers/models on the eight-GiB Mac."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
OUT = parser.parse_args().output.resolve()
OUT.mkdir(parents=True, exist_ok=False)
EVIDENCE = OUT.parent
bundle = OUT / 'staged-engine' / 'index.js'
bundle.parent.mkdir()
commands = [
 ('focused', ['npx','jest','--coverage=false','--runInBand',
  'src/__tests__/memory.integrity.test.ts','src/__tests__/memory.retrieval.factory.test.ts','src/__tests__/bots.foundation.test.ts',
  'src/__tests__/memory.wiring.test.ts','src/__tests__/memory.vector.store.test.ts','src/__tests__/memory.store.features.test.ts',
  'src/__tests__/rag.sprint.test.ts','src/__tests__/rag.resources.test.ts','src/__tests__/fault.audit.regression.test.ts',
  'src/__tests__/subagent.manager.test.ts','src/__tests__/subagent.capacity.test.ts',
  'src/__tests__/context.orchestration.sprint.test.ts','src/__tests__/context.work.sprint.test.ts']),
 ('bun', ['npm','run','test:bun']),
 ('context', ['npm','run','test:context']),
 ('context-benchmark', ['npm','run','bench:context']),
 ('scripts', ['npm','run','test:scripts']),
 ('root-build', ['npm','run','build']),
 ('app-typecheck', ['npm','--prefix','app','run','typecheck']),
 ('app-build', ['npm','--prefix','app','run','build']),
 ('lint', ['npm','run','lint']),
 ('isolated-engine-build', ['bun','build','src/index.ts','--target=node',f'--outdir={bundle.parent}']),
 ('engine-protocol', ['npm','--prefix','app','run','verify:engine','--',str(bundle)]),
]
records = []
source_files = sorted(set((ROOT/'src').rglob('*.ts')))
hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}
(OUT/'starting-source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
for name, command in commands:
    env = dict(os.environ)
    # Respect per-fixture cwd/state ownership; do not force one global BIMAX_STATE_DIR over tests.
    if name == 'context-benchmark': env['BIMAX_CONTEXT_BENCH_OUT'] = str(OUT/'context-benchmark')
    if name == 'engine-protocol':
        env['BIMAX_BREAKGLASS_DIR'] = str(OUT/'engine-config')
        env['BIMAX_KEY_LEDGER_PATH'] = 'memory'
    started = datetime.now(timezone.utc).isoformat()
    before = time.monotonic()
    with (OUT/f'{name}.log').open('w') as log:
        try:
            run = subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=600)
            code = run.returncode
        except subprocess.TimeoutExpired: code = 124
    record = {'name':name,'command':command,'startedAt':started,'seconds':round(time.monotonic()-before,3),'exitCode':code,'log':f'{name}.log'}
    records.append(record)
    (OUT/'progress.json').write_text(json.dumps(records,indent=2)+'\n')
    print(json.dumps(record),flush=True)
unchanged = all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==h for p,h in hashes.items())
result={'commands':records,'sourceUnchangedDuringQualification':unchanged,
        'bundleSha256':hashlib.sha256(bundle.read_bytes()).hexdigest() if bundle.exists() else None}
(OUT/'results.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(0 if unchanged and all(r['exitCode']==0 for r in records) else 1)
