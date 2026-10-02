#!/usr/bin/env python3
"""Mutate one behavior at a time, require an actual Jest assertion failure, restore exact bytes. Run from repo root."""
from pathlib import Path
import subprocess,re,json
out=Path(__file__).resolve().parents[1]
mutants=[
 ('no_default','src/tools/implementations/look.tool.ts',"args.action === undefined ? 'look' : args.action",'args.action','src/__tests__/look.host.call.test.ts','named app with omitted action'),
 ('replay_message_return','app/src/main/computer/look.service.ts','!front && searching && boxes.length === 1','!front && boxes.length === 1','app/src/__tests__/computer.press.test.ts','unchanged Return in a message box'),
 ('old_field_name','app/src/main/computer/look.service.ts','field: boxes[0].label','field: el.label','app/src/__tests__/computer.press.test.ts','failed background search proposes'),
]
results=[]
for name,file,old,new,suite,test in mutants:
 p=Path(file);original=p.read_bytes()
 try:
  s=original.decode();assert old in s;p.write_text(s.replace(old,new))
  run=subprocess.run(['npx','jest','--runInBand','--coverage=false',suite,'--testNamePattern='+test],capture_output=True,text=True)
  assert run.returncode and re.search(r'Tests:\s+\d+ failed',run.stderr+run.stdout), (name,run.stderr[-1800:])
  results.append({'mutant':name,'caught':True,'evidence':'behavior assertion failed; compilation succeeded'})
 finally:p.write_bytes(original)
(out/'mutants.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results,indent=2))
