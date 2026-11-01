"""Grade actual Electron host authority against disposable source faults."""
import hashlib,json,os,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=root/'app/src/main/responder/host-controls.ts'
original=source.read_bytes();text=original.decode()
faults={
 'foreign-peer-grant':('operation.peer === this.peer','true'),
 'stop-does-not-reach-engine':('await this.stopRemote();','await Promise.resolve();'),
 'disconnect-keeps-grant':('this.peer = null;\n      this.indicator?.destroy();','return;\n      this.peer = null;\n      this.indicator?.destroy();'),
}
output=Path(os.environ['BIMAX_HOST_EVIDENCE']);output.mkdir(parents=True,exist_ok=True)
results=[]
with tempfile.TemporaryDirectory(prefix='bimax-host-faults-') as d:
 for name,(before,after) in faults.items():
  assert text.count(before)==1,name
  mutant=Path(d)/(name+'.ts');mutant.write_text(text.replace(before,after))
  result=subprocess.run(['node','app/scripts/verify-mobile-host-controls.mjs',str(output/name)],cwd=root,env={**os.environ,'BIMAX_HOST_SOURCE':str(mutant)},capture_output=True,text=True,timeout=30)
  log=result.stdout+result.stderr;(output/(name+'.log')).write_text(log)
  caught=result.returncode!=0 and 'AssertionError' in log
  results.append({'fault':name,'assertionCaught':caught,'exitCode':result.returncode});assert caught,name
assert source.read_bytes()==original
(output/'source-faults.json').write_text(json.dumps({'sourceSha256':hashlib.sha256(original).hexdigest(),'faults':results,'sourceUntouched':True},indent=2)+'\n')
print('All three disposable host authority faults were caught by Electron assertions.')
