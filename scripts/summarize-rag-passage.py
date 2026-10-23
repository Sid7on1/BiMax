#!/usr/bin/env python3
"""Audit every paired answer against raw requests and source text before reporting quality."""
import argparse,ast,collections,datetime,hashlib,importlib.util,json,statistics,string,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];EVIDENCE=ROOT/'docs/product-reset/evidence/2026-10-14-rag-passage'
OLD=ROOT/'docs/product-reset/evidence/2026-10-14-rag-qualification'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('run',type=Path);p.add_argument('--output',type=Path,required=True)
p.add_argument('--candidate-source',type=Path,help='Explicit frozen candidate TS snapshot after reverting production; exact recorded source hash is still required.')
args=p.parse_args()
run=args.run.resolve();config=json.loads((run/'configuration.json').read_text());summary=json.loads((run/'summary.json').read_text())
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
selection=json.loads((EVIDENCE/'public-selection.json').read_text());cache=Path(selection['cache']);retrieval=Path(config['retrievalRun'])
freeze=json.loads((EVIDENCE/'evaluation-freeze.json').read_text())
assert all(sha(ROOT/path)==digest for path,digest in freeze['sourceHashes'].items()),'Pre-inference dependency freeze changed'
assert all(freeze['sourceHashes'].get(path)==digest for path,digest in config['sourceHashes'].items()),'Run dependencies differ from pre-inference freeze'
assert config['productionRecallAtStart']==freeze['productionRecallSha256']
assert all(sha(cache/path)==digest for path,digest in selection['rawCorpusHashes'].items()),'Raw selected corpus changed'
assert sha(EVIDENCE/'public-selection.json')==config['selectionSha256']
resolved={path:(args.candidate_source.resolve() if path=='src/memory/recall.ts' and args.candidate_source else ROOT/path) for path in config['sourceHashes']}
assert all(sha(resolved[path])==digest for path,digest in config['sourceHashes'].items())
assert summary['validAnswers']==100 and not summary['invalid'] and summary['configUnchanged']
assert len(controls:=json.loads((run/'judge-self-check.json').read_text()))==22 and all(c['passed'] for c in controls)
expected={(item['id'],arm) for group in selection['selection'].values() for item in group for arm in ['baseline','current']}
rows=[json.loads(f.read_text()) for f in run.glob('*-result.json')]
assert len(rows)==100 and {(r['id'],r['arm']) for r in rows}==expected and all(r['valid'] for r in rows)
# Audit one corpus at a time instead of retaining every public history on an eight-GiB Mac.
rows.sort(key=lambda row:(row['dataset'],row['row'],row['id'],row['arm']))
spec=importlib.util.spec_from_file_location('grader',ROOT/'scripts/lib/rag_public_grader.py');grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
tree=ast.parse((ROOT/'scripts/bench-rag-public.py').read_text());ingestion={}
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ['documents_lme','documents_mab']]
exec(compile(ast.Module(body=functions,type_ignores=[]),'source-only-ingestion','exec'),ingestion)
# Reconstruct the exact frozen judge messages without executing its provider/setup code.
rubric_tree=ast.parse((OLD/'research/LongMemEval-evaluate_qa.py').read_text())
judge_namespace={'json':json,'grader':grader}
rubric=[node for node in rubric_tree.body if isinstance(node,ast.FunctionDef) and node.name=='get_anscheck_prompt'];assert len(rubric)==1
exec(compile(ast.Module(body=rubric,type_ignores=[]),'pinned-rubric','exec'),judge_namespace)
judge_namespace['judge_prompt']=judge_namespace['get_anscheck_prompt']
def capture_judge(messages,label,judge=False):
 assert judge
 judge_namespace['captured_messages']=messages
 return 'yes',None
judge_namespace['request']=capture_judge
judge_function=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='judge'];assert len(judge_function)==1
exec(compile(ast.Module(body=judge_function,type_ignores=[]),'frozen-judge-messages','exec'),judge_namespace)
originals={};source_coverage={};reference_presence={};cases={};accepted_calls=[]
old_ids={r['id'] for g in json.loads((OLD/'public-selection.json').read_text())['selection'].values() for r in g}
old_questions={' '.join(json.loads(f.read_text())['question'].lower().split()) for f in (OLD/'public-answer-nemotron-4').glob('*-result.json')}
rejected=ROOT/'docs/product-reset/evidence/2026-10-14-rag-evidence'
old_ids.update(r['id'] for g in json.loads((rejected/'public-selection.json').read_text())['selection'].values() for r in g)
old_questions.update(' '.join(json.loads(f.read_text())['question'].lower().split()) for f in (rejected/'public-answer-8').glob('*-result.json'))
assert not ({id for id,_ in expected}&old_ids)
for row in rows:
 assert ' '.join(row['question'].lower().split()) not in old_questions
 cached=json.loads((retrieval/(row['id']+'-retrieval.json')).read_text());assert cached['valid'] and cached['rag']['sameSources']
 assert row['rag']==cached['rag'][row['arm']],(row['id'],row['arm'],'reused retrieval changed')
 assert all(row[k]==cached[k] for k in ['question','references','kind','abstention','date','stratum'])
 corpus_key=(row['dataset'],row['row'])
 if corpus_key not in originals:
  originals.clear()
  docs=raw=None
  raw=json.loads((cache/f"{'lme' if row['dataset']=='longmemeval' else 'mab'}-{row['row']}.json").read_text())
  docs=ingestion['documents_lme' if row['dataset']=='longmemeval' else 'documents_mab'](raw)
  originals[corpus_key]=({doc['id']:doc for doc in docs},raw)
 assert len(originals)==1
 docs,raw=originals[corpus_key]
 prompt=row['rag']['prompt'];budget=1800 if row['arm']=='baseline' else 6000
 assert len(prompt.split('\n',1)[1] if '\n' in prompt else '')<=budget
 assert row['rag']['provenance'] and (not prompt or row['rag']['evidence'])
 for span in row['rag']['evidence']:
  id=span['locator']['documentId'];source=docs[id]['text']
  assert span['sourceId']=='memory:'+id and span['sourceVersion']=='sha256:'+hashlib.sha256(source.encode()).hexdigest()
  assert span['text'] in prompt and ' '.join(span['text'].split()) in ' '.join(source.split())
  assert not span.get('validFrom'), 'No source dates may be guessed from recency'
 if row['dataset']=='longmemeval' and not row['abstention']:
  source_coverage[(row['id'],row['arm'])]=grader.source_metrics([docs[id].get('sourceSessionId',id) for id in row['rag']['ids']],raw['answer_session_ids'])
 if not row['abstention'] and row['kind']!='single-session-preference':
  matched=[bool(grader.normalize(a)) and grader.normalize(a) in grader.normalize(prompt) for a in row['references']]
  reference_presence[(row['id'],row['arm'])]=all(matched) if row['stratum'].startswith('eventqa') else any(matched)
 origin=Path(row['inferenceRun']);label=row['id']+'-'+row['arm']
 for role in ['reader','judge']:
  valid=[(f,json.loads(f.read_text())) for f in origin.glob(label+'-'+role+'-attempt-*.json') if json.loads(f.read_text())['valid']]
  assert len(valid)==1,(label,role)
  file,a=valid[0];text=grader.completion_text(a['status'],a['response']);body=a['request'];assert body['model']==config[role] and a['response']['model']==config[role] and body['temperature']==0 and body['max_tokens']==2048
  assert body['chat_template_kwargs']=={'enable_thinking':True} and body['reasoning_budget']==1024
  assert row[role+'WallMs']==a['wallMs'] and row[role+'Usage']==a['response'].get('usage'),(label,role,'cost observation drift')
  transport_file=origin/f"transport-{label}-{role}-{a['attempt']}.json"
  transport=json.loads(transport_file.read_text()) if transport_file.exists() else None
  if transport:assert transport['status']==a['status'] and transport['attempt']==a['attempt'] and transport['label']==label+'-'+role
  accepted_calls.append({'dataset':row['dataset'],'arm':row['arm'],'role':role,'file':str(file),
   'attemptWallMsIncludingAdmission':a['wallMs'],'httpWallMs':transport['httpWallMs'] if transport else a['wallMs'],
   'slotAndGateWaitMs':transport['slotAndGateWaitMs'] if transport else 0,'transportInstrumented':transport is not None})
  if role=='reader':
   assert text==row['prediction']
   assert body['messages'][0]=={'role':'system','content':'Answer the question using only the retrieved history. If it is insufficient, say you do not know. Prefer the latest dated evidence when facts change. Give a concise, complete answer.'}
   assert body['messages'][1]['content']==f"Question date: {row['date'] or 'not specified'}\nQuestion: {row['question']}\n\nRetrieved history:\n{prompt or '(no evidence retrieved)'}"
  else:
   assert grader.judge_verdict(text)==row['correct']
   judge_namespace['judge'](row['question'],row['references'],row['prediction'],row['kind'],row['abstention'],'offline-audit',
    required_all=row['dataset']=='memoryagentbench' and row['stratum'].startswith('eventqa'))
   assert body['messages']==judge_namespace['captured_messages'],(label,'judge input drift')
 assert grader.answer_metrics(row['prediction'],row['references'])==row['answerMetrics']
 cases.setdefault(row['id'],{})[row['arm']]=row
def dist(values):
 values=sorted(values);n=len(values)
 return {'count':n,'median':statistics.median(values) if n else None,'p95':values[min(n-1,int(.95*n))] if n else None,'min':values[0] if n else None,'max':values[-1] if n else None}
def paired(group):
 a=[pair['baseline'] for pair in group];b=[pair['current'] for pair in group]
 before=sum(r['correct'] for r in a);after=sum(r['correct'] for r in b);n=len(group)
 return {'questions':n,'baselineCorrect':before,'currentCorrect':after,'baselineAccuracy':before/n,'currentAccuracy':after/n,
  'gainPercentagePoints':100*(after-before)/n,'gained':sum(not x['correct'] and y['correct'] for x,y in zip(a,b)),
  'lost':sum(x['correct'] and not y['correct'] for x,y in zip(a,b)),
  'bothCorrect':sum(x['correct'] and y['correct'] for x,y in zip(a,b)),'bothWrong':sum(not x['correct'] and not y['correct'] for x,y in zip(a,b))}
datasets={}
for dataset in selection['selection']:
 group=[pair for pair in cases.values() if pair['baseline']['dataset']==dataset];assert len(group)==25
 metrics={**paired(group),'strata':{kind:paired([p for p in group if p['baseline']['stratum']==kind]) for kind in sorted({p['baseline']['stratum'] for p in group})}}
 if dataset=='longmemeval':
  metrics['answerable']=paired([p for p in group if not p['baseline']['abstention']])
  metrics['sourceCoverage']={arm:{'questions':len(source_coverage)//2,'recallAt3':statistics.mean(v['recallAt3'] for (id,a),v in source_coverage.items() if a==arm),'complete':sum(v['complete'] for (id,a),v in source_coverage.items() if a==arm)} for arm in ['baseline','current']}
 metrics['literalReferencePresence']={arm:{'eligible':len(g:=[v for (id,a),v in reference_presence.items() if a==arm and cases[id]['baseline']['dataset']==dataset]),'present':sum(g),'definition':'Diagnostic containment only; excludes preferences and abstentions, not answer correctness.'} for arm in ['baseline','current']}
 metrics['promptChars']={arm:dist([p[arm]['rag']['prompt'].__len__() for p in group]) for arm in ['baseline','current']}
 metrics['readerLatencyMs']={arm:dist([p[arm]['readerWallMs'] for p in group]) for arm in ['baseline','current']}
 metrics['judgeLatencyMs']={arm:dist([p[arm]['judgeWallMs'] for p in group]) for arm in ['baseline','current']}
 metrics['acceptedCallLatency']={arm:{role:{key:dist([c[key] for c in accepted_calls if c['dataset']==dataset and c['arm']==arm and c['role']==role])
  for key in ['attemptWallMsIncludingAdmission','httpWallMs','slotAndGateWaitMs']} for role in ['reader','judge']} for arm in ['baseline','current']}
 metrics['acceptedUsage']={arm:{role:{k:sum((pair[arm].get(role+'Usage') or {}).get(k,0) for pair in group) for k in ['prompt_tokens','completion_tokens','total_tokens']} for role in ['reader','judge']} for arm in ['baseline','current']}
 metrics['acceptedUsageAvailability']={arm:{role:{'calls':len(group),'callsWithUsage':sum(isinstance(pair[arm].get(role+'Usage'),dict) for pair in group)} for role in ['reader','judge']} for arm in ['baseline','current']}
 datasets[dataset]=metrics
# Preserved licensed upstream MemoryAgentBench metric functions, without imports or network helpers.
upstream=EVIDENCE/'research/MemoryAgentBench-eval_other_utils.py';tree=ast.parse(upstream.read_text())
names={'normalize_answer','f1_score','drqa_exact_match_score','substring_exact_match_score','drqa_metric_max_over_ground_truths','parse_output'}
namespace={'re':re,'string':string,'Counter':collections.Counter}
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names];assert len(functions)==6
exec(compile(ast.Module(body=functions,type_ignores=[]),str(upstream),'exec'),namespace)
max_gold=namespace['drqa_metric_max_over_ground_truths']
def standard(prediction,answers):return {'exactMatch':float(max_gold(namespace['drqa_exact_match_score'],prediction,answers)),
 'tokenF1':max_gold(lambda p,g:namespace['f1_score'](p,g)[0],prediction,answers),'substringExactMatch':float(max_gold(namespace['substring_exact_match_score'],prediction,answers))}
mab=[]
for row in rows:
 if row['dataset']!='memoryagentbench':continue
 prediction=row['prediction'];parsed=namespace['parse_output'](prediction);answers=row['references']
 values=standard(parsed if parsed is not None else '',answers) if row['stratum'].startswith('eventqa') else standard(prediction,answers)
 if row['stratum'].startswith('eventqa'):values['eventqaRecall']=float(all(a.lower() in prediction.lower() for a in answers))
 elif parsed is not None:
  parsed_values=standard(parsed,answers);values={k:max(v,parsed_values[k]) for k,v in values.items()}
 mab.append({'id':row['id'],'arm':row['arm'],'family':row['stratum'],**values})
mab_arms={arm:{'overall':{k:statistics.mean(r[k] for r in mab if r['arm']==arm) for k in ['exactMatch','tokenF1','substringExactMatch']},
 'families':{family:{'count':len(g:=[r for r in mab if r['arm']==arm and r['family']==family]),**{k:statistics.mean(r[k] for r in g) for k in g[0] if k not in ['id','arm','family']}} for family in sorted({r['family'] for r in mab})}} for arm in ['baseline','current']}
usage=collections.Counter();attempts=[];runs=[];origin=run;transport_profiles=[];transport_attempts=[]
def add_usage(value,prefix=''):
 for k,v in value.items():
  if isinstance(v,dict):add_usage(v,prefix+k+'.')
  elif isinstance(v,(int,float)):usage[prefix+k]+=v
while origin not in runs:
 runs.append(origin)
 for file in origin.glob('*-attempt-*.json'):
  data=json.loads(file.read_text());attempts.append({'file':str(file),'valid':data['valid'],'judge':data['judge'],'wallMs':data['wallMs'],'status':data.get('status'),'error':data.get('error')});add_usage(data.get('response',{}).get('usage') or {})
 profile=origin/'transport-wrapper.json'
 if profile.exists():
  receipt=json.loads(profile.read_text())
  wrappers=list((ROOT/'scripts').glob('bench-rag-passage-throttle*.py'))
  assert receipt['wrapperSha256'] in {sha(p) for p in wrappers},'Transport wrapper source drift'
  assert receipt['driverSha256']==config['sourceHashes']['scripts/bench-rag-passage-model.py']
  if 'checkpointSha256' in receipt:assert receipt['checkpointSha256']==sha(ROOT/'scripts/lib/rag_benchmark_checkpoint.py')
  transport_profiles.append({'run':str(origin),**receipt})
  for file in origin.glob('transport-*.json'):
   if file==profile:continue
   transport_attempts.append({'file':str(file),**json.loads(file.read_text())})
 previous=json.loads((origin/'configuration.json').read_text()).get('resumeFrom')
 if not previous:break
 origin=Path(previous)
corpora=[json.loads(f.read_text()) for f in retrieval.glob('*-ingestion.json')]
embeddings={r['embedding'] for r in corpora};assert len(embeddings)==1
batch=[b for r in corpora for b in r['embeddingObservations']]
fresh=[b for b in batch if not b.get('cacheHit')];truncated=[b for b in fresh if b['requiredProviderTruncation']]
value={'scope':selection['scope'],'selectionSha256':config['selectionSha256'],'model':config['reader'],'judge':config['judge'],'settings':config['modelSettings'],
 'candidateSourceSnapshot':str(args.candidate_source.resolve()) if args.candidate_source else None,
 'all100AnswersValid':True,'all50QuestionsPaired':True,'rawReaderJudgeAudits':100,'provenanceAudits':100,'maximumCachedSourceCorpora':1,'oldQuestionIdsOverlap':0,'oldNormalizedQuestionsOverlap':0,
 'preInferenceFreezeVerified':True,'rawCorpusHashesVerified':len(selection['rawCorpusHashes']),
 'datasets':datasets,'mabUpstreamMetrics':{'method':'Preserved upstream functions and family postprocessing; no ROUGE or complete official evaluator/leaderboard.','sourceSha256':sha(upstream),'arms':mab_arms,'questions':mab},
 'embeddingExecution':'Serial local batches16,requestedCPU-only num_gpu0/num_thread1; exact real model-digest/role/text-keyed original seed cache reused read-only; overlay commits once per fresh batch.',
 'embedding':next(iter(embeddings)),'corpora':len(corpora),'documents':sum(r['documents'] for r in corpora),'chunks':sum(r['chunks'] for r in corpora),
 'embeddingCache':{'freshPassageInputs':sum(b['inputs'] for b in fresh),'cachedPassageInputs':sum(b['inputs'] for b in batch if b.get('cacheHit')),'cachedPotentiallyTruncatedInputs':sum(b.get('potentiallyTruncatedInputs',0) for b in batch)},
 'embeddingTruncation':{'freshAffectedPassageBatches':len(truncated),'freshAffectedInputBound':[sum(b['truncationAffectedInputsBound'][0] for b in truncated),sum(b['truncationAffectedInputsBound'][1] for b in truncated)],'definition':'Batch bounds only. Cached vectors retain conservative original batch truncation flags; no per-chunk truncation rate.'},
 'providerAttempts':len(attempts),'providerStatusCounts':dict(collections.Counter(str(r['status']) for r in attempts)),
 'invalidProviderAttempts':[r for r in attempts if not r['valid']],'reportedUsageAllRetainedAttempts':dict(usage),
 'transportRecovery':{'profiles':transport_profiles,'recordedHTTPAttempts':len(transport_attempts),
  'slotAndGateWaitMs':dist([r['slotAndGateWaitMs'] for r in transport_attempts]),'httpWallMs':dist([r['httpWallMs'] for r in transport_attempts]),
  'latencyDefinition':'Attempt wall time includes admission/cooldown in wrapper runs and transport-receipt publication overhead in durable runs. Separate wrapper HTTP and slot/gate times are recorded; earlier runs used HTTP/decode wall time without this wrapper. Failed HTTP calls without a response have no separate transport observation. These are service observations, not paired speed claims.'},
 'attemptRuns':[str(p) for p in runs],'newJudgeControlRequests':0,'reusedPassingJudgeControls':22,'cost':'Currency cost not available; usage not converted to assumed prices.',
 'started':min(json.loads((p/'configuration.json').read_text())['started'] for p in runs),'ended':summary['ended'],
 'limitations':['Small25+25 balanced fresh query-heldout pilot, shared corpora/questions across source families; not independent population samples or official leaderboard.',
  'Same-model self-judging and hosted serving version not independently pinned; controls do not establish human agreement.',
  'Candidate changes both excerpt selection and default excerpt allowance 1800 to6000; measured gain cannot be attributed to only one.',
  'Record96 and97 scores belong to different subsets and candidates; compare only the fresh paired25-question per-dataset denominators.',
  'Embedding truncation is explicit; no reranker. Public timings are shared-machine/service observations, not qualified speed ratios.',
  'Interrupted in-flight calls without a returned record have unknown usage; every recorded attempt and all valid answers are retained.',
  'Accepted-attempt latency excludes earlier failed attempts/backoff. Wrapper admission/cooldown is separated where instrumented; no end-to-end speedup or energy claim.']}
value['adoption']={'bothDatasetsNetAccuracyGain':all(d['gainPercentagePoints']>0 for d in datasets.values()),
 'rule':'Require positive paired net accuracy in both datasets plus zero provenance/scope/budget/required-contract failures. Report losses and declining strata; no release qualification.'}
with args.output.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
print(json.dumps({k:v for k,v in value.items() if k not in ['mabUpstreamMetrics','invalidProviderAttempts']},indent=2))
if not value['adoption']['bothDatasetsNetAccuracyGain']:raise SystemExit(2)
