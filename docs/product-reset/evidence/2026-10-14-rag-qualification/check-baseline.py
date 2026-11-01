from pathlib import Path
import subprocess,hashlib,json,time
root=Path(__file__).resolve().parents[4]; out=Path(__file__).resolve().parent
paths=['src/memory/vector.store.ts','src/memory/recall.ts']; original={p:(root/p).read_bytes() for p in paths}; results=[]
try:
 for p in paths:(root/p).write_bytes((out/'baseline'/p).read_bytes())
 for name,cmd in [('baseline-resource-contracts',['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','src/__tests__/rag.resources.test.ts']),('baseline-unrelated-jest',['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','app/src/__tests__/desktop.runtime.security.test.ts','app/src/main/responder/__tests__/adapter.test.ts'])]:
  started=time.monotonic()
  with (out/(name+'.log')).open('x') as log:run=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT)
  results.append({'name':name,'command':cmd,'exit':run.returncode,'seconds':time.monotonic()-started})
finally:
 for p,data in original.items():(root/p).write_bytes(data)
 results.append({'exactRestoration':all((root/p).read_bytes()==b for p,b in original.items()),'restoredHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}})
 (out/'baseline-isolation.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
