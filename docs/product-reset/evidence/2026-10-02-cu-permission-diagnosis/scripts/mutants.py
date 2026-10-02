#!/usr/bin/env python3
from pathlib import Path
import subprocess,re,json
p=Path('app/src/main/computer/look.failure.ts'); original=p.read_bytes();out=Path(__file__).resolve().parents[1];results=[]
mutants=[('keyword_as_permission','accessibilityGranted === undefined && explicitDenial','accessibilityGranted === undefined && axRelated'),('ignore_positive_probe','accessibilityGranted === false','accessibilityGranted !== undefined'),('ignore_negative_probe','accessibilityGranted === false','accessibilityGranted === undefined')]
for name,old,new in mutants:
 try:
  s=original.decode();assert old in s;p.write_text(s.replace(old,new))
  r=subprocess.run(['npx','jest','--runInBand','--coverage=false','app/src/__tests__/computer.look.test.ts','--testNamePattern=enabled native grant|without a permission probe|native refusal uses'],capture_output=True,text=True)
  assert r.returncode and re.search(r'Tests:\s+\d+ failed',r.stdout+r.stderr),(name,r.stderr[-1600:])
  results.append({'mutant':name,'caught':True,'failure':'behavior assertion; compiled successfully'})
 finally:p.write_bytes(original)
(out/'mutants.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results,indent=2))
