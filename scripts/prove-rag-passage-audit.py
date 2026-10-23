#!/usr/bin/env python3
"""Prove the completed-result auditor rejects tampered observations, without API calls."""
import argparse,datetime,hashlib,json,shutil,subprocess,sys,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('run',type=Path);p.add_argument('--output',type=Path,required=True)
p.add_argument('--candidate-source',type=Path,help='Forward an explicit hash-checked rejected-candidate source snapshot to the auditor.')
args=p.parse_args()
source=args.run.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
auditor=ROOT/'scripts/summarize-rag-passage.py'
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
files=list(source.glob('*-result.json'))
assert len(files)==100 and all(json.loads(f.read_text())['valid'] for f in files)
before={str(f):sha(f) for f in files}
cases=['wrong-verdict','changed-reader-input','missing-answer','wrong-returned-model','changed-cost-observation']
results=[]
for fault in cases:
 with tempfile.TemporaryDirectory(prefix='bimax-rag-audit-fault-') as temporary:
  fixture=Path(temporary)
  for f in files+[source/'configuration.json',source/'summary.json',source/'judge-self-check.json']:
   shutil.copy2(f,fixture/f.name)
  selected=fixture/sorted(files)[0].name;row=json.loads(selected.read_text())
  if fault=='wrong-verdict':row['correct']=not row['correct']
  elif fault=='changed-reader-input':row['rag']['prompt']+='\nUnobserved extra evidence.'
  elif fault=='changed-cost-observation':row['readerWallMs']+=1
  elif fault=='missing-answer':selected.unlink()
  elif fault=='wrong-returned-model':
   original=Path(row['inferenceRun']);label=row['id']+'-'+row['arm'];raw=fixture/'raw';raw.mkdir()
   for role in ['reader','judge']:
    valid=[f for f in original.glob(label+'-'+role+'-attempt-*.json') if json.loads(f.read_text())['valid']]
    assert len(valid)==1
    request=json.loads(valid[0].read_text())
    if role=='reader':request['response']['model']='unconfigured-wrong-model'
    (raw/valid[0].name).write_text(json.dumps(request)+'\n')
   row['inferenceRun']=str(raw)
  if selected.exists():selected.write_text(json.dumps(row)+'\n')
  report=fixture/'report.json'
  command=[sys.executable,str(auditor),str(fixture),'--output',str(report)]
  if args.candidate_source:command.extend(['--candidate-source',str(args.candidate_source.resolve())])
  result=subprocess.run(command,cwd=ROOT,
   capture_output=True,text=True,timeout=120)
  (out/(fault+'.stdout.log')).write_text(result.stdout)
  (out/(fault+'.stderr.log')).write_text(result.stderr)
  caught=result.returncode==1 and 'AssertionError' in result.stderr and not report.exists()
  results.append({'fault':fault,'returncode':result.returncode,'assertionCaught':caught,'reportWritten':report.exists()})
  assert caught,fault
assert all(sha(Path(f))==h for f,h in before.items()),'Original results changed'
value={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'auditorSha256':sha(auditor),
 'proofSha256':sha(Path(__file__)),'run':str(source),'cases':results,'original100RowsUnchanged':True,
 'method':'Temporary copies only; no provider calls, source/grading changes, valid-answer replay or original artifact edits.'}
(out/'results.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps(value,indent=2))
