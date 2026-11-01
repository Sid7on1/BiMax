#!/usr/bin/env python3
"""Audit 200 public retrieval observations; never turn retrieval proxies into model accuracy."""
import argparse,collections,hashlib,json,statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];EVIDENCE=ROOT/'docs/product-reset/evidence/2026-10-14-rag-qualification'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('run',type=Path);p.add_argument('--output',type=Path,required=True);args=p.parse_args();run=args.run.resolve();out=args.output.resolve();assert not out.exists()
selection=json.loads((EVIDENCE/'public-selection.json').read_text());configuration=json.loads((run/'configuration.json').read_text());rows=[json.loads(f.read_text()) for f in run.glob('*-retrieval.json')]
expected={r['id'] for group in selection['selection'].values() for r in group};assert len(rows)==len(expected)==200 and {r['id'] for r in rows}==expected
assert configuration['selectionSha256']==hashlib.sha256((EVIDENCE/'public-selection.json').read_bytes()).hexdigest()
assert all(r['valid'] and r['rag']['same'] for r in rows)
for row in rows:
 for version in ['baseline','current']:
  rag=row['rag'][version];assert rag['provenance'];assert not rag['prompt'] or rag['evidence'];assert len(rag['ids'])<=3
  assert all(span['text'] in rag['prompt'] for span in rag['evidence'])
corpora=[json.loads(f.read_text()) for f in run.glob('*-ingestion.json')];assert len(corpora)==121 and all(c['stats']['pending']==0 and c['stats']['embedded']==c['chunks'] for c in corpora)
spaces={c['embedding'] for c in corpora};assert len(spaces)==1
batches=[b for corpus in corpora for b in corpus['embeddingObservations']];truncated=[b for b in batches if b['requiredProviderTruncation']]
query_truncated=[r['id'] for r in rows if any(b['requiredProviderTruncation'] for b in r['rag']['queryEmbeddingObservations'])]
def dist(values):
 values=sorted(values);return {'count':len(values),'median':statistics.median(values),'p95':values[min(len(values)-1,int(.95*len(values)))],'min':values[0],'max':values[-1]}
summary={'scope':selection['scope'],'questions':200,'corpora':len(corpora),'documents':sum(c['documents'] for c in corpora),'chunks':sum(c['chunks'] for c in corpora),'embedding':next(iter(spaces)),
 'promptEquality':200,'provenance':200,'denseActive':sum(r['rag']['current']['mode']['dense'] for r in rows),'rerankActive':sum(r['rag']['current']['mode']['reranked'] for r in rows),
 'embeddingTruncation':{'passageBatches':len(batches),'affectedPassageBatches':len(truncated),'affectedPassageInputBound':[sum(b['truncationAffectedInputsBound'][0] for b in truncated),sum(b['truncationAffectedInputsBound'][1] for b in truncated)],'affectedQueries':query_truncated},
 'latencyMs':{'queryEmbedding':dist([r['rag']['queryEmbeddingMs'] for r in rows]),'currentRecall':dist([r['rag']['current']['wallMs'] for r in rows]),'ingestionPerCorpus':dist([c['ingestionMs'] for c in corpora])},
 'promptChars':dist([len(r['rag']['current']['prompt']) for r in rows]),'datasets':{},'modelAnswerAccuracy':None,
 'limits':['No hosted answering/judging ran for these retrieval observations.','Reference-text presence is literal containment, not answer accuracy or semantic evidence sufficiency.','Abstention excluded from answer-source recall; preference and abstention excluded from classic literal-reference checks.','No paired public latency speedup claim: shared local load and baseline-first query order.','Balanced subset and small explicitly truncated all-minilm backend with no reranker; no official leaderboard claim.']}
for dataset in selection['selection']:
 group=[r for r in rows if r['dataset']==dataset];source=[r for r in group if not r['abstention'] and r.get('sources') is not None]
 literal=[r for r in group if not r['abstention'] and r['kind']!='single-session-preference']
 source_metrics=[]
 for row in source:
  original=json.loads((Path(selection['cache'])/f"lme-{row['row']}.json").read_text());gold=set(original['answer_session_ids']);hits=row.get('benchmarkSessionIds',row['rag']['current']['ids'])
  first=next((i+1 for i,id in enumerate(hits) if id in gold),None)
  source_metrics.append({'mrr':1/first if first else 0,'precision':len(set(hits)&gold)/len(hits) if hits else 0})
 summary['datasets'][dataset]={'questions':len(group),'answerSourceQuestions':len(source),'meanAnswerSourceRecallAt3':statistics.mean(r['sources']['recallAt3'] for r in source) if source else None,'meanAnswerSourceMrrAt3':statistics.mean(r['mrr'] for r in source_metrics) if source_metrics else None,'meanAnswerSourcePrecisionAt3':statistics.mean(r['precision'] for r in source_metrics) if source_metrics else None,'completeAnswerSources':sum(r['sources']['complete'] for r in source),'literalReferenceQuestions':len(literal),'literalReferencePresent':sum(r['referenceTextPresent'] for r in literal),
  'strata':{kind:{'questions':len(g:=[r for r in group if r['stratum']==kind]),'literalReferencePresent':sum(r['referenceTextPresent'] for r in g),'meanAnswerSourceRecallAt3':statistics.mean(r['sources']['recallAt3'] for r in g if not r['abstention'] and r.get('sources') is not None) if any(not r['abstention'] and r.get('sources') is not None for r in g) else None} for kind in sorted({r['stratum'] for r in group})}}
with out.open('x') as f:json.dump(summary,f,indent=2);f.write('\n')
print(json.dumps(summary,indent=2))
