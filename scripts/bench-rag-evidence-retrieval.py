#!/usr/bin/env python3
"""Complete the fixed public retrieval subset independently of hosted reader availability."""
import argparse,ast,concurrent.futures,datetime,hashlib,importlib.util,json,subprocess,threading
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];EVIDENCE=ROOT/'docs/product-reset/evidence/2026-10-14-rag-evidence'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--reuse-from',type=Path);args=p.parse_args();OUT=args.output.resolve();OUT.mkdir(parents=True,exist_ok=False)
selection=json.loads((EVIDENCE/'public-selection.json').read_text());CACHE=Path(selection['cache']);lock=threading.Lock();progress=[]
spec=importlib.util.spec_from_file_location('grader',ROOT/'scripts/lib/rag_public_grader.py');grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
# Share the exact source-only ingestion functions; no hosted evaluator imports/driver execute.
source=ROOT/'scripts/bench-rag-public.py';tree=ast.parse(source.read_text());namespace={}
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ['documents_lme','documents_mab']];assert len(functions)==2
exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),namespace)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def write(name,data):
 with (OUT/name).open('x') as f:json.dump(data,f,indent=2);f.write('\n')
def job(value):
 dataset,row_at,items=value;row=json.loads((CACHE/f"{'lme' if dataset=='longmemeval' else 'mab'}-{row_at}.json").read_text());label=f'{dataset}-{row_at}'
 with (OUT/(label+'-worker.log')).open('x') as stderr:
  child=subprocess.Popen(['node',str(ROOT/'scripts/rag-evidence-worker.cjs'),str(EVIDENCE)],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True)
  def command(payload):
   child.stdin.write(json.dumps(payload)+'\n');child.stdin.flush();line=child.stdout.readline()
   if not line:raise RuntimeError('RAG worker ended without an observation')
   data=json.loads(line)
   if not data.get('ok'):raise RuntimeError(data.get('error'))
   return data['value']
  try:
   docs=namespace['documents_lme' if dataset=='longmemeval' else 'documents_mab'](row)
   aliases={doc['id']:doc.get('sourceSessionId',doc['id']) for doc in docs}
   ingestion=command({'op':'load','documents':docs});write(label+'-ingestion.json',ingestion)
   for item in items:
    result={**item,'dataset':dataset,'started':now(),'valid':False}
    try:
     if dataset=='longmemeval':
      question,references,kind=row['question'],[str(row['answer'])],row['question_type'];expected=row['answer_session_ids'];abstention=row['question_id'].endswith('_abs');date=row['question_date']
     else:
      i=item['query'];question,references=row['questions'][i],row['answers'][i];expected=[];metadata=row['metadata'];types=metadata.get('question_types') or [];qids=metadata.get('question_ids') or [];dates=metadata.get('question_dates') or [];kind=types[i] if i<len(types) else 'single-session-user';abstention=i<len(qids) and qids[i].endswith('_abs');date=dates[i] if i<len(dates) else None
     rag=command({'op':'query','query':question});assert rag['sameSources']
     for version in ['baseline','current']:assert not rag[version]['prompt'] or rag[version]['evidence']
     # This is text containment, never downstream answer correctness or preference-rubric satisfaction.
     prompt=grader.normalize(rag['current']['prompt']);matches=[bool(grader.normalize(a)) and grader.normalize(a) in prompt for a in references]
     result.update(valid=True,question=question,references=references,kind=kind,abstention=abstention,date=date,rag=rag,benchmarkSessionIds=[aliases[id] for id in rag['current']['ids']],sources=grader.source_metrics([aliases[id] for id in rag['current']['ids']],expected),referenceTextPresent=all(matches) if item['stratum'].startswith('eventqa') else any(matches))
    except Exception as error:result['invalidReason']=str(error)
    result['ended']=now();write(item['id']+'-retrieval.json',result)
    with lock:
     progress.append({'id':item['id'],'dataset':dataset,'valid':result['valid']});(OUT/'progress.json').write_text(json.dumps(progress,indent=2)+'\n');print(f"{len(progress)}/200 {item['id']} valid={result['valid']}",flush=True)
  except Exception as error:write(label+'-job-error.json',{'error':str(error),'remaining':[i['id'] for i in items]})
  finally:
   try:command({'op':'close'})
   except Exception:pass
   try:child.stdin.close()
   except BrokenPipeError:pass
   child.wait(timeout=10)
write('configuration.json',{'scope':selection['scope'],'selectionSha256':hashlib.sha256((EVIDENCE/'public-selection.json').read_bytes()).hexdigest(),'started':now(),'reader':None,'judge':None,'workers':2,'protocol':'Frozen 200 questions; no quality tuning; paired frozen record-96/current inputs, real all-minilm vectors with content-addressed persistent cache, explicit recorded truncation; limit3, baseline1800/current6000 default excerpt budget. No model-answer score.', 'sourceHashes':{str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__),source,ROOT/'scripts/rag-evidence-worker.cjs',ROOT/'scripts/lib/rag_public_grader.py',ROOT/'src/memory/vector.store.ts',ROOT/'src/memory/recall.ts',EVIDENCE/'compiled/baseline.js',EVIDENCE/'compiled/current.js',EVIDENCE/'compiled/recall-baseline.js',EVIDENCE/'compiled/recall-current.js',ROOT/'dist/memory/chunking.js']}})
groups={}
for dataset,items in selection['selection'].items():
 for item in items:groups.setdefault((dataset,item['row']),[]).append(item)
jobs=[(dataset,row,items) for (dataset,row),items in groups.items()];jobs.sort(key=lambda j:hashlib.sha256(f'{j[0]}:{j[1]}'.encode()).hexdigest())
if args.reuse_from:
 previous=json.loads((args.reuse_from/'configuration.json').read_text());assert previous['selectionSha256']==hashlib.sha256((EVIDENCE/'public-selection.json').read_bytes()).hexdigest()
 for path in previous['sourceHashes']:
  if path == str(Path(__file__).relative_to(ROOT)):continue # Parent cleanup only; worker/production/compiled dependencies must match.
  assert previous['sourceHashes'][path]==hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),path
 remaining=[];reused=[]
 for dataset,row_at,items in jobs:
  label=f'{dataset}-{row_at}';ingestion_path=args.reuse_from/(label+'-ingestion.json');results=[args.reuse_from/(item['id']+'-retrieval.json') for item in items]
  row=json.loads((CACHE/f"{'lme' if dataset=='longmemeval' else 'mab'}-{row_at}.json").read_text());docs=namespace['documents_lme' if dataset=='longmemeval' else 'documents_mab'](row)
  # Match JavaScript JSON.stringify bytes, including UTF-8, before reusing actual observations.
  digest=hashlib.sha256(json.dumps(docs,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
  if not ingestion_path.exists() or not all(file.exists() for file in results):remaining.append((dataset,row_at,items));continue
  ingestion=json.loads(ingestion_path.read_text());observations=[json.loads(file.read_text()) for file in results]
  if ingestion['inputSha256']!=digest or not all(record['valid'] for record in observations):remaining.append((dataset,row_at,items));continue
  write(label+'-ingestion.json',ingestion)
  for file,record in zip(results,observations):
   write(file.name,record);progress.append({'id':record['id'],'dataset':dataset,'valid':True});reused.append({'file':file.name,'from':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
 write('reused-observations.json',{'observations':reused,'questions':len(reused),'remainingCorpora':len(remaining),'rule':'Identical selection, production/worker/compiled source and exact corpus input SHA-256; only changed ingestion inputs rerun.'});jobs=remaining
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(job,jobs))
rows=[json.loads(f.read_text()) for f in OUT.glob('*-retrieval.json')];valid=[r for r in rows if r['valid']]
summary={'scope':selection['scope'],'expectedQuestions':200,'attemptedQuestions':len(rows),'validQuestions':len(valid),'invalid':[r['id'] for r in rows if not r['valid']],'datasets':{},'ended':now(),'modelAnswerAccuracy':'unmeasured; no reader/judge invoked'}
for dataset in selection['selection']:
 group=[r for r in valid if r['dataset']==dataset];sources=[r['sources'] for r in group if r['sources'] is not None and not r['abstention']]
 summary['datasets'][dataset]={'questions':len(group),'baselineCurrentPromptEqual':sum(r['rag']['same'] for r in group),'baselineCurrentSourcesEqual':sum(r['rag']['sameSources'] for r in group),'validProvenance':sum(r['rag']['current']['provenance'] for r in group),'answerSourceQuestions':len(sources),'meanAnswerSourceRecallAt3':sum(s['recallAt3'] for s in sources)/len(sources) if sources else None,'completeAnswerSources':sum(s['complete'] for s in sources),'referenceTextPresent':sum(r['referenceTextPresent'] for r in group),'strata':{kind:{'questions':len(g:=[r for r in group if r['stratum']==kind]),'referenceTextPresent':sum(r['referenceTextPresent'] for r in g)} for kind in sorted({r['stratum'] for r in group})}}
write('summary.json',summary);print(json.dumps(summary),flush=True)
if len(rows)!=200 or len(valid)!=200:raise RuntimeError('retrieval qualification incomplete; no full-denominator result')
