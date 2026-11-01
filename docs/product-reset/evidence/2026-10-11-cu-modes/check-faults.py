from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parents[4]
service=root/'app/src/main/computer.use.ts';control=root/'app/src/main/computer/control.ts'
original={p:p.read_text() for p in (service,control)}
faults=[
('guide-native-input',service,"if (INPUT.has(name) && run?.state.mode === 'guide')",'if (false)', 'Guide rejects direct'),
('guide-workflow-mutation',service,"if (run?.state.mode === 'guide') {","if (run?.state.mode === 'teach') {",'Guide checks two'),
('stale-revision',control,'if (revision !== this.state.revision || this.ended)','if (this.ended)','Take over revokes'),
('no-pause-authority',service,'if (run && (run.paused || run.epoch !== epoch))','if (false)','Actual panel approval can pause'),
('trust-driver-done',service,'if (!matches(view, expected)) {','if (!matches(view, expected) && Date.now() < 0) {','No-op done remains'),
('no-independent-read',service,'view = await observe();\n          for (let retry = 0; retry < 2 && !matches(view, expected); retry++) {\n            await new Promise(resolve => setTimeout(resolve, 150)); view = await observe();\n          }', 'view = before;', 'ordered steps independently'),
('duplicate-save',service,'input = true;','input = true; if (step.action === "CLICK") await this.perform(id, "act", { snapshot: (await observe()).snapshot, element: controls[0].id, action: step.action }, signal);','Twenty distinct ordered'),
('guide-bypass-concurrency',service,'if (this.workflowOwners.has(id))','if (false)','Concurrent model input'),
('save-stale-revision',service,'run.state.revision !== revision ||','','Teach save is host-owned'),
]
results=[]
try:
 for name,file,old,new,test in faults:
  assert old in original[file],name
  file.write_text(original[file].replace(old,new,1))
  output=subprocess.run(['npx','jest','--runInBand','--coverage=false','app/src/__tests__/computer.workflow.test.ts','--testNamePattern',test],cwd=root,capture_output=True,text=True,timeout=30)
  combined=output.stdout+output.stderr
  assertion=output.returncode!=0 and 'Test suite failed to run' not in combined and 'Exceeded timeout' not in combined and ('Expected' in combined or 'Phase ' in combined)
  results.append({'fault':name,'assertionCaught':assertion,'exitCode':output.returncode,'test':test})
  (Path(__file__).parent/f'fault-{name}.log').write_text(combined)
  file.write_text(original[file])
finally:
 for file,text in original.items():file.write_text(text)
report={'scope':'implementation mutants only; not model/provider qualification','faults':results,'sourceRestored':all(p.read_text()==v for p,v in original.items())}
(Path(__file__).parent/'faults.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
