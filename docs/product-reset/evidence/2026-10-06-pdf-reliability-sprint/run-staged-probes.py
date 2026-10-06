"""Build fresh isolated engine/PDF probes; never install or call a model."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[4]
EVIDENCE=Path(__file__).resolve().parent
SCRATCH=Path(tempfile.mkdtemp(prefix='bimax-pdf-probe-'))
(SCRATCH/'probe.ts').write_text((EVIDENCE/'pdf-probe-source.ts').read_text().replace('/Users/vishsiddharth/Bimax',str(ROOT)))

def run(command,label,env=None,timeout=180):
 with (EVIDENCE/f'{label}.log').open('w') as out:
  result=subprocess.run(command,cwd=ROOT,stdout=out,stderr=subprocess.STDOUT,env=env,timeout=timeout)
 if result.returncode: raise RuntimeError(f'{label} failed: {result.returncode}')
 return result.returncode

# Engine probe has redirected config/state and no inherited provider credentials or CU flags.
with tempfile.TemporaryDirectory(prefix='bimax-r4-engine-') as stage:
 stage=Path(stage); bundle=stage/'bundle'
 run(['bun','build','src/index.ts','--target=node',f'--outdir={bundle}'],'engine-build')
 env={key:value for key,value in os.environ.items() if not any(word in key.upper() for word in ('API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL')) and not key.startswith(('BGW_','BIMAX_'))}
 env['BIMAX_BREAKGLASS_DIR']=str(stage/'config'); env['BIMAX_STATE_DIR']=str(stage/'state')
 run([str(ROOT/'app/node_modules/.bin/electron'),'app/scripts/verify-engine.js',str(bundle/'index.js')],'engine-smoke',env)
 log=(EVIDENCE/'engine-smoke.log').read_text()
 assert 'answered all 7 exchanges' in log
 (EVIDENCE/'staged-engine.json').write_text(json.dumps({'exchanges':7,'credentialsScrubbed':True,'stateRedirected':True,'modelTurn':False,'installed':False,'bundleSha256':hashlib.sha256((bundle/'index.js').read_bytes()).hexdigest()},indent=2)+'\n')

run(['bun','build',str(SCRATCH/'probe.ts'),'--target=node','--format=cjs',f'--outfile={SCRATCH}/probe.cjs'],'pdf-probe-build')
# Retained QA intermediate, not a user-requested PDF deliverable. Exactly one PDF is authored.
qa=EVIDENCE/'qa'; qa.mkdir(parents=True,exist_ok=True)
marker='/Users/vishsiddharth/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/container_tools/mark_artifact_operation_started.mjs'
run(['node',marker,'--operation-kind','create','--expected-output-count','1','--output-format','pdf'],'pdf-artifact-marker')
run(['node',str(SCRATCH/'probe.cjs'),str(qa/'inspection.pdf')],'pdf-probe')
proof=json.loads((EVIDENCE/'pdf-probe.log').read_text().splitlines()[-1])
(EVIDENCE/'pdf-probe.json').write_text(json.dumps(proof,indent=2)+'\n')
run(['pdftoppm','-r','100','-png',str(qa/'inspection.pdf'),str(qa/'page')],'pdf-render')
assert len(list(qa.glob('page-*.png')))==3
# Keep independent exact-file identities after inspection. Intermediate files can be removed later.
(EVIDENCE/'pdf-render-files.json').write_text(json.dumps({str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(qa.iterdir())},indent=2)+'\n')
import shutil
shutil.rmtree(SCRATCH)
print('Seven staged engine exchanges and bundled PDF probe/render passed; visual inspection remains required.')
