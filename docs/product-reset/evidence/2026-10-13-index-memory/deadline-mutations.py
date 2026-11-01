from pathlib import Path
import subprocess,json,hashlib
OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
file=ROOT/'src/utils/request.deadline.ts';original=file.read_bytes();source=original.decode()
mutations=[
 ('late-success','    remainingMs();\n    return result;', '    return result;', 'cannot resolve'),
 ('late-error','  } catch (error) {\n    remainingMs();\n    throw error;', '  } catch (error) {\n    throw error;', 'cannot reject'),
 ('lost-Stop-reason',"controller.abort(parent?.reason ?? new Error('Operation cancelled.'))",'controller.abort(timeoutError())','Stop keeps'),
]
results=[]
for name,before,after,test in mutations:
 assert source.count(before)==1
 try:
  file.write_text(source.replace(before,after))
  run=subprocess.run(['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','src/__tests__/request.deadline.settlement.test.ts','-t',test],cwd=ROOT,capture_output=True,text=True,timeout=30)
  log=run.stdout+run.stderr;(OUT/f'deadline-mutant-{name}.log').write_text(log)
  caught=run.returncode!=0 and 'expect(received)' in log and not any(s in log for s in ['Test suite failed to run','Exceeded timeout','Cannot find module','FATAL ERROR'])
 finally:file.write_bytes(original)
 r={'fault':name,'exit':run.returncode,'assertion_caught':caught,'exact_restoration':file.read_bytes()==original,'restored_sha256':hashlib.sha256(file.read_bytes()).hexdigest()};results.append(r);print(json.dumps(r),flush=True)
run=subprocess.run(['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','src/__tests__/request.deadline.settlement.test.ts'],cwd=ROOT,capture_output=True,text=True,timeout=30)
(OUT/'deadline-restored.log').write_text(run.stdout+run.stderr)
(OUT/'deadline-mutations.json').write_text(json.dumps({'faults':results,'restored_exit':run.returncode},indent=2)+'\n')
assert run.returncode==0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results)
