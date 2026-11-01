#!/usr/bin/env python3
"""Freeze the authorized fresh25+25 subset using bounded sequential corpus reads."""
import hashlib,json,sys
from pathlib import Path
import pyarrow.parquet as pq
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'docs/product-reset/evidence/2026-10-14-rag-passage'
OLD=ROOT/'docs/product-reset/evidence/2026-10-14-rag-qualification';REJECTED=ROOT/'docs/product-reset/evidence/2026-10-14-rag-evidence'
sys.path.insert(0,str(ROOT/'scripts/lib'))
from rag_json_array import iter_array
from rag_benchmark_checkpoint import immutable_json
RECOVERY=Path('/Users/vishsiddharth/Library/Caches/BimaxBench/rag-evidence-20261014')
CACHE=RECOVERY/'fresh50-raw';CACHE.mkdir(exist_ok=True)
datasets=json.loads((OLD/'public-selection.json').read_text())['datasets']
def digest_file(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while block:=f.read(1024*1024):h.update(block)
 return h.hexdigest()
paths=[RECOVERY/'longmemeval_s_cleaned.json',RECOVERY/'Accurate_Retrieval.parquet']
for path,expected in zip(paths,datasets):assert path.stat().st_size==expected['bytes'] and digest_file(path)==expected['sha256']
normalize=lambda s:' '.join(s.lower().split())
old_ids=set();old_questions=set()
for folder,run in [(OLD,'public-answer-nemotron-4'),(REJECTED,'public-answer-8')]:
 selection=json.loads((folder/'public-selection.json').read_text())['selection']
 old_ids.update(item['id'] for group in selection.values() for item in group)
 for file in (folder/run).glob('*-result.json'):old_questions.add(normalize(json.loads(file.read_text())['question']))
seed='bimax-rag-complete-passage-fresh50-2026-10-14-v1'
def select(items):
 groups={}
 for item in items:groups.setdefault(item['stratum'],[]).append(item)
 for group in groups.values():group.sort(key=lambda item:hashlib.sha256((seed+json.dumps(item,sort_keys=True)).encode()).hexdigest())
 selected=[]
 while len(selected)<25:
  before=len(selected)
  for name in sorted(groups):
   if groups[name] and len(selected)<25:selected.append(groups[name].pop(0))
  assert len(selected)>before
 return selected
observation={};lme_items=[];count=0
for i,row in enumerate(iter_array(paths[0],observations=observation)):
 count+=1
 if row['question_id'] not in old_ids and normalize(row['question']) not in old_questions:
  lme_items.append({'row':i,'id':row['question_id'],'stratum':'abstention' if row['question_id'].endswith('_abs') else row['question_type']})
assert count==500
def mab_rows():
 for batch in pq.ParquetFile(paths[1]).iter_batches(batch_size=1,use_threads=False):
  yield batch.to_pylist()[0]
mab_items=[];questions=0;count=0
for i,row in enumerate(mab_rows()):
 count+=1;questions+=len(row['questions'])
 for j,question in enumerate(row['questions']):
  if f'mab-{i}-{j}' not in old_ids and normalize(question) not in old_questions:
   mab_items.append({'row':i,'query':j,'id':f'mab-{i}-{j}','stratum':row['metadata']['source']})
assert count==22 and questions==2000
selected={'longmemeval':select(lme_items),'memoryagentbench':select(mab_items)}
assert len({r['id'] for g in selected.values() for r in g})==50
assert not ({r['id'] for g in selected.values() for r in g}&old_ids)
needed={r['row'] for r in selected['longmemeval']};raw_hashes={}
for i,row in enumerate(iter_array(paths[0],observations=observation)):
 if i in needed:
  assert normalize(row['question']) not in old_questions
  target=CACHE/f'lme-{i}.json';immutable_json(target,row);raw_hashes[target.name]=digest_file(target)
needed={r['row'] for r in selected['memoryagentbench']}
for i,row in enumerate(mab_rows()):
 if i in needed:
  assert all(normalize(row['questions'][r['query']]) not in old_questions for r in selected['memoryagentbench'] if r['row']==i)
  target=CACHE/f'mab-{i}.json';immutable_json(target,row);raw_hashes[target.name]=digest_file(target)
immutable_json(OUT/'public-selection.json',{'selectionVersion':seed,'scope':'Owner-authorized fresh balanced25classicLongMemEval_S+25MemoryAgentBench,paired100answer arms; excludes all record96+97 IDs and normalized questions. Small pilot,shared public corpora,not independent population/official leaderboard.',
 'datasets':datasets,'selection':selected,'cache':str(CACHE),'oldIdsExcluded':len(old_ids),'oldQuestionsExcluded':len(old_questions),'rawCorpusHashes':raw_hashes,'preparation':{'lmeSequentialPasses':2,**observation,'parquetRowsPerBatch':1,'parquetThreads':False},
 'rule':'Metadata/hash-only before inference; no answer/retrieval outcome selects cases; no same-question duplicates across earlier experiments.'})
print(json.dumps({'questions':50,'perDataset':25,'corpora':len(raw_hashes),'oldIdsExcluded':len(old_ids),'oldNormalizedQuestionsExcluded':len(old_questions),'stream':observation}))
