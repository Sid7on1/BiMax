from pathlib import Path
import subprocess,json,time,datetime,sys
OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
COMMANDS=[
 ('focused',['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','src/__tests__/compiler.lifetime.sprint.test.ts','src/__tests__/request.deadline.settlement.test.ts','src/__tests__/graph.freshness.sprint.test.ts','src/__tests__/performance.sprint.test.ts']),
 ('build',['npm','run','build']),
 ('app-typecheck',['npm','--prefix','app','run','typecheck']),
 ('lint',['npm','run','lint']),
 ('full-jest',['node','node_modules/jest/bin/jest.js','--coverage=false','--maxWorkers=2']),
 ('full-bun',['npm','run','test:bun']),
 ('node-scripts',['npm','run','test:scripts']),
 ('app-build',['npm','--prefix','app','run','build']),
 ('engine-build',['npm','run','build:engine']),
 ('engine-smoke',['npm','--prefix','app','run','verify:engine']),
]
results=json.loads((OUT/'verification.json').read_text()) if '--resume' in sys.argv else []
completed={r['name'] for r in results}
for name,cmd in COMMANDS:
 if name in completed:continue
 started=datetime.datetime.now(datetime.timezone.utc).isoformat();start=time.monotonic()
 with (OUT/f'{name}.log').open('w') as log:run=subprocess.run(cmd,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=300)
 r={'name':name,'command':cmd,'started':started,'seconds':time.monotonic()-start,'exit':run.returncode,'log':f'{name}.log'};results.append(r)
 (OUT/'verification.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(r),flush=True)
 if run.returncode:raise SystemExit(run.returncode)
