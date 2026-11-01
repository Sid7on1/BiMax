#!/usr/bin/env python3
"""Audit a complete fixed public qualification and derive observational metrics from raw evidence."""
import argparse, ast, collections, datetime, hashlib, importlib.util, json, re, statistics, string
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
EVIDENCE=ROOT/'docs/product-reset/evidence/2026-10-14-rag-qualification'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('run',type=Path);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
run=args.run.resolve();out=args.output.resolve();assert not out.exists()
selection=json.loads((EVIDENCE/'public-selection.json').read_text());config=json.loads((run/'configuration.json').read_text())
summary=json.loads((run/'summary.json').read_text())
assert hashlib.sha256((EVIDENCE/'public-selection.json').read_bytes()).hexdigest()==config['selectionSha256']
expected={row['id'] for group in selection['selection'].values() for row in group}
rows=[json.loads(f.read_text()) for f in run.glob('*-result.json')]
assert len(expected)==len(rows)==200 and {row['id'] for row in rows}==expected
assert all(row['valid'] and row['rag']['same'] and row['rag']['current']['provenance'] and row['rag']['baseline']['provenance'] for row in rows)
assert all(row['passed'] for row in json.loads((run/'judge-self-check.json').read_text()))
assert summary['secretFileUnchanged']
assert summary['validQuestions']==200 and not summary['invalidQuestions']
assert summary['reader']==config['reader'] and summary['judge']==config['judge']
for path,expected_hash in config['sourceHashes'].items():
 assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==expected_hash, path
spec=importlib.util.spec_from_file_location('qualification_grader',ROOT/'scripts/lib/rag_public_grader.py')
grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
for row in rows:
 origin=Path(row['inferenceRun'])
 for role in ['reader','judge']:
  attempts_for_role=[json.loads(f.read_text()) for f in origin.glob(row['id']+'-'+role+'-attempt-*.json')]
  valid_attempts=[a for a in attempts_for_role if a['valid']]
  assert len(valid_attempts)==1,(row['id'],role)
  attempt=valid_attempts[0];text=grader.completion_text(attempt['status'],attempt['response'])
  assert attempt['model']==config[role]
  if role=='reader':
   assert text==row['prediction']
   assert attempt['request']['messages'][1]['content']==f"Question date: {row['date'] or 'not specified'}\nQuestion: {row['question']}\n\nRetrieved history:\n{row['rag']['current']['prompt'] or '(no evidence retrieved)'}"
  else: assert grader.judge_verdict(text)==row['correct']
 assert grader.answer_metrics(row['prediction'],row['references'])==row['answerMetrics']
for dataset,metrics in summary['datasets'].items():
 group=[row for row in rows if row['dataset']==dataset]
 assert metrics['valid']==len(group)==100
 assert metrics['correct']==sum(row['correct'] for row in group)
 assert metrics['judgeAccuracy']==metrics['correct']/len(group)
# Licensed, preserved first-party metric functions only; no module imports, network helpers or ROUGE surrogate.
source=EVIDENCE/'research/MemoryAgentBench-eval_other_utils.py';tree=ast.parse(source.read_text())
names={'normalize_answer','f1_score','drqa_exact_match_score','substring_exact_match_score','drqa_metric_max_over_ground_truths','parse_output'}
namespace={'re':re,'string':string,'Counter':collections.Counter}
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
assert len(functions)==len(names)
exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),namespace)
max_gold=namespace['drqa_metric_max_over_ground_truths']
def standard(prediction,answers):
 return {'exactMatch':float(max_gold(namespace['drqa_exact_match_score'],prediction,answers)),
         'tokenF1':max_gold(lambda p,g:namespace['f1_score'](p,g)[0],prediction,answers),
         'substringExactMatch':float(max_gold(namespace['substring_exact_match_score'],prediction,answers))}
metrics=[]
for row in rows:
 if row['dataset']!='memoryagentbench':continue
 prediction,answers=row['prediction'],row['references']; parsed=namespace['parse_output'](prediction)
 if row['stratum'].startswith('eventqa'):
  values=standard(parsed,answers);values['eventqaRecall']=float(all(answer.lower() in prediction.lower() for answer in answers))
 else:
  values=standard(prediction,answers)
  if parsed is not None:
   parsed_values=standard(parsed,answers);values={name:max(value,parsed_values[name]) for name,value in values.items()}
 metrics.append({'id':row['id'],'family':row['stratum'],**values})
def distribution(values):
 values=sorted(values);n=len(values)
 return {'count':n,'median':statistics.median(values) if n else None,'p95':values[min(n-1,int(.95*n))] if n else None,'min':values[0] if n else None,'max':values[-1] if n else None}
usage=collections.Counter(); attempts=collections.Counter();invalid_attempts=[];attempt_times={'reader':[],'judge':[]}
def add_usage(value,prefix=''):
 for k,v in value.items():
  name=prefix+k
  if isinstance(v,dict):add_usage(v,name+'.')
  elif isinstance(v,(int,float)):usage[name]+=v
for file in run.glob('*-attempt-*.json'):
 data=json.loads(file.read_text());role='judge' if data['judge'] else 'reader';attempts[role]+=1;attempt_times[role].append(data['wallMs'])
 if not data['valid']:invalid_attempts.append({'file':file.name,'status':data.get('status'),'error':data.get('error')})
 add_usage(data.get('response',{}).get('usage') or {})
corpus_run=Path(config['cachedRetrieval']) if config.get('cachedRetrieval') else run
corpora=[json.loads(file.read_text()) for file in corpus_run.glob('*-ingestion.json')]
embeddings={corpus['embedding'] for corpus in corpora};assert len(embeddings)==1
truncated=[batch for corpus in corpora for batch in corpus['embeddingObservations'] if batch['requiredProviderTruncation']]
query_truncated=[row['id'] for row in rows if any(batch['requiredProviderTruncation'] for batch in row['rag']['queryEmbeddingObservations'])]
source_rows=[row for row in rows if row.get('sources') is not None and not row.get('abstention')]
value={'scope':selection['scope'],'selectionSha256':config['selectionSha256'],'all200Valid':True,'baselineCurrentPromptEqual':200,
 'reader':config['reader'],'judge':config['judge'],'modelDifference':config['modelDifference'],
 'rawCompletionAudit':{'readerPrompts':200,'readerPredictions':200,'judgeVerdicts':200,'sourceHashes':'all match frozen run configuration'},
 'judgedAnswers':summary['datasets'],'started':config['started'],'ended':summary['ended'],
 'answerRunElapsedSeconds':(datetime.datetime.fromisoformat(summary['ended'])-datetime.datetime.fromisoformat(config['started'])).total_seconds(),
 'provenance':'Exact source IDs/UTF-8 hashes and exact shown spans; source containment permits production chunker whitespace changes.',
 'embedding':list(embeddings)[0],'corpora':len(corpora),'documents':sum(c['documents'] for c in corpora),'chunks':sum(c['chunks'] for c in corpora),
 'embeddingTruncation':{'affectedPassageBatches':len(truncated),'affectedPassageInputBound':[sum(b['truncationAffectedInputsBound'][0] for b in truncated),sum(b['truncationAffectedInputsBound'][1] for b in truncated)],'affectedQueries':query_truncated},
 'upstreamMabMetrics':{'method':'Preserved upstream EM/F1/substring helpers and published family postprocessing; ROUGE excluded, not a complete official evaluator or leaderboard.',
  'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'overall':{k:statistics.mean(row[k] for row in metrics) for k in ['exactMatch','tokenF1','substringExactMatch']},
  'families':{family:{'count':len(group:=[row for row in metrics if row['family']==family]),**{k:statistics.mean(row[k] for row in group) for k in group[0] if k not in ['id','family']}} for family in sorted({row['family'] for row in metrics})},'questions':metrics},
 'longmemevalAnswerableSourceCoverage':{'questions':len(source_rows),'meanRecallAt3':statistics.mean(row['sources']['recallAt3'] for row in source_rows),'complete':sum(row['sources']['complete'] for row in source_rows)},
 'latencyMs':{'reader':distribution([row['readerWallMs'] for row in rows]),'judge':distribution([row['judgeWallMs'] for row in rows]),'queryEmbedding':distribution([row['rag']['queryEmbeddingMs'] for row in rows]),'currentRecall':distribution([row['rag']['current']['wallMs'] for row in rows]),'ingestionPerCorpus':distribution([corpus['ingestionMs'] for corpus in corpora])},
 'latencyMethod':'Reader/judge distributions describe the accepted completion attempt only; elapsed run time includes controls, retries and pacing. Provider-attempt distributions below include retries and the 17 initial controls.',
 'providerAttemptLatencyMs':{role:distribution(times) for role,times in attempt_times.items()},
 'providerAttempts':dict(attempts),'invalidProviderAttempts':invalid_attempts,'reportedUsageAllAttemptsIncludingControls':dict(usage),
 'cost':'Currency cost unavailable from this configured endpoint; usage and failures are reported rather than inferred prices.',
 'caveats':['Balanced qualification subset, not natural-population estimate or leaderboard.',f"Reader {config['reader']}, judge {config['judge']}; correlated judging errors remain possible.",'Small all-minilm backend has explicit measured truncation; no reranker.','Public latencies are observations on a shared local machine and hosted service, not a paired performance claim.','Identical baseline/current prompts share a model response; no independent answer-accuracy improvement claim.']}
with out.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
print(json.dumps({k:v for k,v in value.items() if k not in ['upstreamMabMetrics','invalidProviderAttempts']},indent=2))
