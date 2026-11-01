from pathlib import Path
import subprocess,json,hashlib
r=Path(__file__).resolve().parent;root=r.parents[3]
service=root/'app/src/main/computer.use.ts';message=root/'app/src/main/computer/message.ts'
original={p:p.read_text() for p in (service,message)}
faults=[
 ('keep-consumed-draft',service,'if (draft >= 0) established.splice(draft, 1);','if (false) established.splice(draft, 1);','with 0 identical'),
 ('accept-duplicate-send',message,'outgoingCount(view, message) === count + 1','outgoingCount(view, message) >= count + 1','duplicate cannot'),
 ('omit-recipient-proof',message,"if (!exactMatch(view, message.recipient))","if (false)",'wrong or absent recipient'),
 ('skip-after-approval-check',service,'check.validate(fresh);','/* missing fresh validation */','change during Send approval'),
 ('ignore-existing-messages',service,'baseline = outgoingCount(view, message!);','baseline = 0;','with 1 identical'),
 ('allow-direct-send',service,"&& !check?.message) throw new Error('Use a SEND_MESSAGE", "&& false) throw new Error('Use a SEND_MESSAGE",'direct Send and Return'),
 ('accept-stale-after-approval',service," || fresh.snapshot === snapshot!.native",'', 'stale-snapshot after Send'),
 ('accept-ambiguous-recipient',message,'return found.length === 1 &&','return found.length >= 1 &&','duplicate recipient evidence'),
]
faults.append(('unobserved-outgoing-role',message,"if (!selectControl(view, message.outgoing).length)","if (false)",'invented outgoing role'))
report=[]
try:
 for name,file,old,new,test in faults:
  assert old in original[file],name
  file.write_text(original[file].replace(old,new,1))
  output=subprocess.run(['npx','jest','--runInBand','--coverage=false','app/src/__tests__/computer.message.test.ts','--testNamePattern',test],cwd=root,capture_output=True,text=True,timeout=50)
  combined=output.stdout+output.stderr
  caught=output.returncode!=0 and 'Test suite failed to run' not in combined and 'Exceeded timeout' not in combined and 'expect(received)' in combined
  report.append({'fault':name,'assertionCaught':caught,'exitCode':output.returncode,'test':test});(r/f'fault-{name}.log').write_text(combined)
  file.write_text(original[file]);print(name,caught,flush=True)
finally:
 for p,value in original.items():p.write_text(value)
result={'sourceRestored':all(p.read_text()==v for p,v in original.items()),'sourceSha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in original},'faults':report}
(r/'faults.json').write_text(json.dumps(result,indent=2)+'\n')
assert all(row['assertionCaught'] for row in report)
