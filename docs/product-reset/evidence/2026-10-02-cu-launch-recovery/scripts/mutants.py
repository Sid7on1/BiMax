#!/usr/bin/env python3
from pathlib import Path
import subprocess,re,json
out=Path(__file__).resolve().parents[1]
mutants=[
 ('no_launch_hint','src/tools/gui.automation.guard.ts',"const launchHint = capabilityToolName === 'PressInAppTool'",'const launchHint = false','src/__tests__/gui.automation.guard.test.ts','copyable background launch'),
 ('unsafe_launch_hint','src/tools/gui.automation.guard.ts',r'[\p{L}\p{N} ._+-]+',r'[^\n]+','src/__tests__/gui.automation.guard.test.ts','shell syntax or extra authority'),
 ('advertise_denied_app','app/src/main/computer/look.service.ts','!neverTouched(a) && words(a.name)','words(a.name)','app/src/__tests__/computer.look.test.ts','never suggests denied apps'),
]
results=[]
for name,file,old,new,suite,pattern in mutants:
 p=Path(file);original=p.read_bytes()
 try:
  text=original.decode();assert old in text;p.write_text(text.replace(old,new))
  r=subprocess.run(['npx','jest','--runInBand','--coverage=false',suite,'--testNamePattern='+pattern],capture_output=True,text=True)
  assert r.returncode and re.search(r'Tests:\s+\d+ failed',r.stdout+r.stderr),(name,r.stderr[-2000:])
  results.append({'mutant':name,'caught':True,'failure':'behavior assertion; compiled successfully'})
 finally:p.write_bytes(original)
(out/'mutants.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results,indent=2))
