#!/usr/bin/env python3
"""Qualify evidence-selection checks with executable source faults and exact restoration."""
from pathlib import Path
import hashlib,json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/product-reset/evidence/2026-10-14-rag-passage/mutations-qualified'
OUT.mkdir(exist_ok=False)
source=ROOT/'docs/product-reset/evidence/2026-10-14-rag-passage/candidate/recall.ts';original=source.read_bytes();text=original.decode();digest=hashlib.sha256(original).hexdigest()
faults=[
 ('long-line-head','return wordWindow(lines[best], query, budget);','return lines[best].slice(0, budget).trimEnd();'),
 ('source-starvation','const share = later ? Math.floor(budget / (later + 1)) : budget;','const share = budget - later * reservePerSource;'),
 ('chunk-starvation','const share = Math.floor(available / remaining);','const share = available;'),
 ('uniform-fragments','const completeRoom = available - (remaining - 1) * (MIN_EXCERPT_CHARS + LABEL_ALLOWANCE);','const completeRoom = share;'),
 ('drop-later-reserve','const completeRoom = available - (remaining - 1) * (MIN_EXCERPT_CHARS + LABEL_ALLOWANCE);','const completeRoom = available;'),
 ('drop-date','if (header && !segments.some(segment => segment.body.includes(header))) {','if (false && header && !segments.some(segment => segment.body.includes(header))) {'),
 ('reverse-duplicate','for (const chunk of matched) {','for (const chunk of [...matched].reverse()) {'),
 ('overclaim-span','const text = segment.body.slice(0, Math.max(0, Math.min(segment.body.length, shownChars - start))).trimEnd();','const text = segment.chunk?.text ?? segment.body;'),
 ('invent-date',"const finish = (segments: Passage['segments']): Passage => {","const finish = (segments: Passage['segments']): Passage => {\n    if (doc.lastUsedAt) segments.unshift({chunk:null,label:'',body:String(doc.lastUsedAt)});"),
 ('no-hit-tail',"if (best < 0) return text.slice(0, budget).trimEnd();","if (best < 0) return text.slice(-budget).trimEnd();"),
 ('default-starvation','const maxChars = options.maxChars ?? 6_000;','const maxChars = options.maxChars ?? 1_800;'),
]
command=['node','--test','scripts/rag-passage-candidate.test.cjs']
def run(name):
 result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=90)
 log=result.stdout+result.stderr;(OUT/(name+'.log')).write_text(log)
 return result.returncode,log
results=[]
try:
 code,log=run('current-before');assert code==0
 for name,before,after in faults:
  assert text.count(before)==1,(name,text.count(before))
  try:
   source.write_text(text.replace(before,after))
   code,log=run(name)
   caught=code==1 and ('AssertionError' in log or 'ERR_ASSERTION' in log) and '# fail' in log and not re.search(r'error TS\d|SyntaxError|heap out of memory|SIGKILL',log)
   results.append({'fault':name,'exit':code,'assertionCaught':caught})
  finally:source.write_bytes(original)
  assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
  (OUT/'results.json').write_text(json.dumps({'sourceSha256':digest,'results':results},indent=2)+'\n')
  print(f'{name}: assertionCaught={caught}',flush=True)
 code,log=run('restored');assert code==0
 assert all(r['assertionCaught'] for r in results)
finally:
 source.write_bytes(original)
 (OUT/'restoration.json').write_text(json.dumps({'expected':digest,'actual':hashlib.sha256(source.read_bytes()).hexdigest()},indent=2)+'\n')
