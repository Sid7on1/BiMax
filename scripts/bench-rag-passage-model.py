#!/usr/bin/env python3
"""Paired model answers on frozen query-heldout RAG inputs; all valid answers retained."""
import argparse, concurrent.futures, datetime, hashlib, json, runpy, statistics, sys, threading, time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
EVIDENCE=ROOT/'docs/product-reset/evidence/2026-10-14-rag-passage'
OLD=ROOT/'docs/product-reset/evidence/2026-10-14-rag-qualification'
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,required=True);p.add_argument('--retrieval-run',type=Path,required=True)
p.add_argument('--resume-from',type=Path);args=p.parse_args()
out=args.output.resolve();retrieval=args.retrieval_run.resolve()
old=json.loads((OLD/'public-answer-nemotron-4/configuration.json').read_text())
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
for path in ['scripts/bench-rag-public.py','scripts/lib/rag_public_grader.py']:
 assert sha(ROOT/path)==old['sourceHashes'][path]
assert sha(OLD/'research/LongMemEval-evaluate_qa.py')==old['promptSourceSha256']
controls=json.loads((OLD/'public-answer-nemotron-4/judge-self-check.json').read_text())
extra=json.loads((OLD/'public-rubric-controls-1/results.json').read_text())
assert len(controls)==17 and len(extra)==5 and all(r['passed'] for r in controls+extra)
sys.argv=['bench-rag-public.py','--output',str(out),'--model',old['judge'],'--thinking-budget','1024','--workers','1']
# Execute first-party setup only, not its old main/selection loop. Reuse the exact frozen HTTP/judge functions.
ns=runpy.run_path(str(ROOT/'scripts/bench-rag-public.py'),run_name='frozen_rag_model_functions')
write=ns['immutable'];request=ns['request'];judge=ns['judge'];grader=ns['grader'];now=ns['now']
selection=json.loads((EVIDENCE/'public-selection.json').read_text())
items=[{**item,'dataset':dataset} for dataset,group in selection['selection'].items() for item in group]
items.sort(key=lambda item:hashlib.sha256(item['id'].encode()).hexdigest())
assert len(items)==50 and len({r['id'] for r in items})==50
paths=[Path(__file__),ROOT/'scripts/bench-rag-public.py',ROOT/'scripts/lib/rag_public_grader.py',ROOT/'scripts/rag-passage-worker.cjs',ROOT/'scripts/lib/rag_vector_cache.cjs',ROOT/'scripts/lib/rag_benchmark_checkpoint.py',
 EVIDENCE/'baseline/src/memory/recall.ts',EVIDENCE/'candidate/recall.ts',ROOT/'src/memory/vector.store.ts',EVIDENCE/'compiled/recall-baseline.js',EVIDENCE/'compiled/recall-current.js',
 EVIDENCE/'compiled/baseline.js',EVIDENCE/'compiled/current.js',ROOT/'dist/memory/chunking.js',ROOT/'dist/context/evidence.js']
hashes={str(path.relative_to(ROOT)):sha(path) for path in paths}
production_start=sha(ROOT/'src/memory/recall.ts')
assert production_start==sha(EVIDENCE/'baseline/src/memory/recall.ts'),'Keep isolated candidate outside production until qualified'
configuration={'productionRecallAtStart':production_start,'started':now(),'reader':old['reader'],'judge':old['judge'],'modelSettings':{k:old[k] for k in ['readerMaxTokens','judgeMaxTokens','temperature','reasoning','rpm']},
 'selectionSha256':sha(EVIDENCE/'public-selection.json'),'sourceHashes':hashes,'retrievalRun':str(retrieval),
 'scope':selection['scope'],'arms':{'baseline':'Frozen record-96 recall, limit3/excerpts1800','current':'Isolated complete-passage candidate,limit3/default excerpts6000'},
 'controls':'Reuse 17+5 passing controls only under identical model/settings/judge source/published rubric; original raw attempts and failures retained.',
 'controlRun':str(OLD/'public-answer-nemotron-4'),'extraControlRun':str(OLD/'public-rubric-controls-1'),
 'baselineComparison':'New fresh25+25 paired query-heldout pilot; earlier 40/100 and39/100 are historical, not the paired denominator.',
 'resumeFrom':str(args.resume_from.resolve()) if args.resume_from else None}
write('configuration.json',configuration);write('judge-self-check.json',controls+extra)
progress=[];lock=threading.Lock();reused={}
if args.resume_from:
 previous=json.loads((args.resume_from/'configuration.json').read_text())
 assert previous['sourceHashes']==hashes and previous['selectionSha256']==configuration['selectionSha256']
 assert previous['modelSettings']==configuration['modelSettings'] and previous['reader']==old['reader'] and previous['judge']==old['judge']
 for file in args.resume_from.glob('*-result.json'):
  row=json.loads(file.read_text())
  if row['valid']:
   origin=Path(row['inferenceRun']);label=row['id']+'-'+row['arm']
   for role in ['reader','judge']:
    valid=[json.loads(f.read_text()) for f in origin.glob(label+'-'+role+'-attempt-*.json') if json.loads(f.read_text())['valid']]
    assert len(valid)==1
    text=grader.completion_text(valid[0]['status'],valid[0]['response'])
    assert text==row['prediction'] if role=='reader' else grader.judge_verdict(text)==row['correct']
   write(file.name,row);reused[(row['id'],row['arm'])]=row;progress.append({'id':row['id'],'arm':row['arm'],'valid':True})
 write('reused-results.json',{'rule':'Reuse all valid answers including wrong answers; only absent/invalid arms may retry.','results':list(reused)})
def evaluate(item):
 cached=json.loads((retrieval/(item['id']+'-retrieval.json')).read_text())
 assert cached['valid'] and cached['rag']['sameSources']
 arms=['baseline','current'] if int(hashlib.sha256(item['id'].encode()).hexdigest(),16)%2 else ['current','baseline']
 for arm in arms:
  if (item['id'],arm) in reused:continue
  label=item['id']+'-'+arm;rag=cached['rag'][arm]
  record={**{k:v for k,v in cached.items() if k!='rag'},'rag':rag,'arm':arm,'started':now(),'valid':False,'inferenceRun':str(out)}
  try:
   assert rag['provenance'] and (not rag['prompt'] or rag['evidence'])
   prediction,call=request([{'role':'system','content':'Answer the question using only the retrieved history. If it is insufficient, say you do not know. Prefer the latest dated evidence when facts change. Give a concise, complete answer.'},
    {'role':'user','content':f"Question date: {cached['date'] or 'not specified'}\nQuestion: {cached['question']}\n\nRetrieved history:\n{rag['prompt'] or '(no evidence retrieved)'}"}],label+'-reader')
   correct,judgment=judge(cached['question'],cached['references'],prediction,cached['kind'],cached['abstention'],label+'-judge',
    required_all=cached['dataset']=='memoryagentbench' and cached['stratum'].startswith('eventqa'))
   record.update(valid=True,prediction=prediction,correct=correct,answerMetrics=grader.answer_metrics(prediction,cached['references']),
    readerUsage=call['response'].get('usage'),judgeUsage=judgment['response'].get('usage'),readerWallMs=call['wallMs'],judgeWallMs=judgment['wallMs'])
  except Exception as error:record['invalidReason']=type(error).__name__
  record['ended']=now();write(label+'-result.json',record)
  with lock:
   progress.append({'id':item['id'],'arm':arm,'valid':record['valid']})
   (out/'progress.json').write_text(json.dumps(progress,indent=2)+'\n')
   print(f"{len(progress)}/100 {label} valid={record['valid']}",flush=True)
# Overlap independent local ingestion with hosted inference. A partially written JSON is never submitted.
pending={item['id']:item for item in items};submitted=[];deadline=time.monotonic()+4*3600
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
 while pending:
  for id,item in list(pending.items()):
   file=retrieval/(id+'-retrieval.json')
   if not file.exists():continue
   try:row=json.loads(file.read_text())
   except json.JSONDecodeError:continue
   assert row['valid'],id
   submitted.append(pool.submit(evaluate,item));del pending[id]
  if pending:
   if (retrieval/'summary.json').exists():raise RuntimeError('Retrieval ended without all selected cases')
   if time.monotonic()>deadline:raise TimeoutError('Local retrieval did not complete within four hours')
   time.sleep(2)
 for future in submitted:future.result()
rows=[json.loads(f.read_text()) for f in out.glob('*-result.json')]
retrieval_summary=json.loads((retrieval/'summary.json').read_text());assert retrieval_summary['validQuestions']==50
assert all(sha(ROOT/path)==digest for path,digest in hashes.items())
assert sha(ROOT/'src/memory/recall.ts')==production_start,'Production changed during isolated evaluation'
summary={'scope':selection['scope'],'expectedAnswers':100,'validAnswers':sum(r['valid'] for r in rows),'invalid':[r['id']+'-'+r['arm'] for r in rows if not r['valid']],
 'datasets':{},'ended':now(),'configUnchanged':ns['hashlib'].sha256(ns['SECRETS'].read_bytes()).hexdigest()==ns['secret_before']}
for dataset in selection['selection']:
 summary['datasets'][dataset]={}
 for arm in ['baseline','current']:
  group=[r for r in rows if r['dataset']==dataset and r['arm']==arm and r['valid']]
  summary['datasets'][dataset][arm]={'valid':len(group),'correct':sum(r['correct'] for r in group),
   'strata':{kind:{'valid':len(g:=[r for r in group if r['stratum']==kind]),'correct':sum(r['correct'] for r in g)} for kind in sorted({r['stratum'] for r in group})}}
write('summary.json',summary);print(json.dumps(summary),flush=True)
if len(rows)!=100 or summary['validAnswers']!=100:raise RuntimeError('Paired qualification incomplete; no complete-denominator score')
