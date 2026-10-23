#!/usr/bin/env python3
"""Recover pinned public datasets and freeze a new query-heldout qualification."""
import ast, concurrent.futures, hashlib, json, time
from pathlib import Path
import requests
import pyarrow.parquet as pq

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/product-reset/evidence/2026-10-14-rag-evidence'
OLD=ROOT/'docs/product-reset/evidence/2026-10-14-rag-qualification'
CACHE=Path('/tmp/bimax-rag-evidence-20261014');CACHE.mkdir(exist_ok=True)
datasets=json.loads((OLD/'public-selection.json').read_text())['datasets']
def sha(data):return hashlib.sha256(data).hexdigest()
def download(name,url,size,digest):
 target=CACHE/name
 if target.exists() and target.stat().st_size==size and sha(target.read_bytes())==digest:return target
 block=8*1024*1024
 def part(start):
  end=min(size,start+block)-1;dest=CACHE/(name+f'.part-{start}');observations=[];failures=0
  with requests.Session() as session:
   while start+(dest.stat().st_size if dest.exists() else 0)<=end:
    offset=start+(dest.stat().st_size if dest.exists() else 0);stop=min(end,offset+512*1024-1)
    try:
     with session.get(url+f'&part={offset}',headers={'Range':f'bytes={offset}-{stop}'},stream=True,timeout=(15,45)) as response:
      response.raise_for_status()
      assert response.status_code==206 and response.headers.get('Content-Range')==f'bytes {offset}-{stop}/{size}'
      with dest.open('ab') as f:
       for data in response.iter_content(65536):f.write(data)
      assert start+dest.stat().st_size==stop+1
     observations.append({'offset':offset,'stop':stop,'valid':True});failures=0
    except Exception as error:
     observations.append({'offset':offset,'stop':stop,'valid':False,'error':type(error).__name__});failures+=1
     if failures>=5:raise
     time.sleep(min(8,2**failures))
    finally:(OUT/f'download-{name}-{start}.json').write_text(json.dumps(observations,indent=2)+'\n')
  print(f'downloaded {name} {start}-{end}',flush=True);return dest
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:parts=list(pool.map(part,range(0,size,block)))
 with target.open('wb') as f:
  for p in parts:
   with p.open('rb') as source:
    while data:=source.read(1024*1024):f.write(data)
 assert target.stat().st_size==size and sha(target.read_bytes())==digest
 return target
lme_path=download('longmemeval_s_cleaned.json',datasets[0]['url'],datasets[0]['bytes'],datasets[0]['sha256'])
mab_url=f"https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/{datasets[1]['revision']}/data/Accurate_Retrieval-00000-of-00001.parquet?download=true"
mab_path=download('Accurate_Retrieval.parquet',mab_url,datasets[1]['bytes'],datasets[1]['sha256'])
lme=json.loads(lme_path.read_text());mab=pq.read_table(mab_path).to_pylist()
assert len(lme)==500 and len(mab)==22 and sum(len(r['questions']) for r in mab)==2000
old_selection=json.loads((OLD/'public-selection.json').read_text())['selection']
old_ids={r['id'] for group in old_selection.values() for r in group}
normalize=lambda q:' '.join(q.lower().split())
old_questions={normalize(json.loads(f.read_text())['question']) for f in (OLD/'public-answer-nemotron-4').glob('*-result.json')}
seed='bimax-rag-evidence-heldout-2026-10-14-v1'
def select(items):
 groups={}
 for item in items:groups.setdefault(item['stratum'],[]).append(item)
 for group in groups.values():group.sort(key=lambda item:sha((seed+json.dumps(item,sort_keys=True)).encode()))
 selected=[]
 while len(selected)<100:
  before=len(selected)
  for name in sorted(groups):
   if groups[name] and len(selected)<100:selected.append(groups[name].pop(0))
  assert len(selected)>before,'Insufficient unseen queries'
 return selected
lme_items=[{'row':i,'id':r['question_id'],'stratum':'abstention' if r['question_id'].endswith('_abs') else r['question_type']}
 for i,r in enumerate(lme) if r['question_id'] not in old_ids and normalize(r['question']) not in old_questions]
mab_items=[{'row':i,'query':j,'id':f'mab-{i}-{j}','stratum':r['metadata']['source']}
 for i,r in enumerate(mab) for j,q in enumerate(r['questions']) if f'mab-{i}-{j}' not in old_ids and normalize(q) not in old_questions]
selected={'longmemeval':select(lme_items),'memoryagentbench':select(mab_items)}
assert not ({r['id'] for group in selected.values() for r in group}&old_ids)
for i,r in enumerate(lme):(CACHE/f'lme-{i}.json').write_text(json.dumps(r))
for i,r in enumerate(mab):(CACHE/f'mab-{i}.json').write_text(json.dumps(r))
manifest={'selectionVersion':seed,'scope':'New query-heldout balanced 100 classic LongMemEval_S +100 MemoryAgentBench Accurate_Retrieval; no prior selected IDs or normalized questions. Shared public corpora, not corpus-heldout or official leaderboard.',
 'datasets':datasets,'selection':selected,'cache':str(CACHE),'oldQuestionsExcluded':len(old_questions),'oldIdsExcluded':len(old_ids),
 'rule':'Metadata/hash-only selection before inference; answers and retrieval outputs never select cases.'}
with (OUT/'public-selection.json').open('x') as f:json.dump(manifest,f,indent=2);f.write('\n')
print('New qualification fixed: 100 + 100 query-heldout cases',flush=True)
