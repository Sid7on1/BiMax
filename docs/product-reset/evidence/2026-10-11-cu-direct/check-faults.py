from pathlib import Path
import subprocess,json
root=Path(__file__).resolve().parents[4];r=Path(__file__).parent
service=root/'app/src/main/computer.use.ts';targets=root/'app/src/main/computer/targets.ts';composer=root/'app/src/renderer/src/components/Composer.tsx'
original={p:p.read_text() for p in (service,targets,composer)}
faults=[
('missing-admission',service,'if (this.options.requireTarget && !target && !automatic)','if (false)','ordinary turn cannot guess CU'),
('guessed-pid',service,'if (!own.apps.has(pid))','if (false)','direct route refuses guessed'),
('guessed-window',service,"if (['observe', 'settle', 'wait'].includes(name) && !own.windows.get(pid)?.has(windowId))",'if (false)','direct route refuses guessed'),
('foreign-native-window',service,'if (automatic && (value.pid !== pid || value.window_id !== (snapshot?.window_id ?? args.window_id)))','if (false)','direct native read cannot return'),
('changed-executable',service,'if (!identity || (previous && (previous.path !== identity.path || previous.sha256 !== identity.sha256)))','if (!identity)','direct executable replacement'),
('foreign-ticket',targets,'if (!receipt || receipt.owner !== threadId)','if (!receipt)','direct tickets are single use'),
('required-picker-ui',composer,'(cuRequest === null || !!cuRequest)','(cuRequest === null)','renderer'),
]
results=[]
try:
 for name,file,old,new,test in faults:
  assert old in original[file],name
  file.write_text(original[file].replace(old,new,1))
  cmd=['node','app/scripts/ui/cu-direct.mjs',str(r/'renderer-mutant.json')] if test=='renderer' else ['npx','jest','--runInBand','--coverage=false','app/src/__tests__/computer.route.test.ts','--testNamePattern',test]
  output=subprocess.run(cmd,cwd=root,capture_output=True,text=True,timeout=55)
  combined=output.stdout+output.stderr
  caught=output.returncode!=0 and 'Test suite failed to run' not in combined and 'TimeoutError' not in combined and 'Exceeded timeout' not in combined and ('Expected' in combined or 'AssertionError' in combined)
  results.append({'fault':name,'assertionCaught':caught,'exitCode':output.returncode,'test':test})
  (r/f'fault-{name}.log').write_text(combined)
  file.write_text(original[file])
finally:
 for file,text in original.items():file.write_text(text)
report={'faults':results,'sourceRestored':all(p.read_text()==v for p,v in original.items())};(r/'faults.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
assert all(v['assertionCaught'] for v in results)
