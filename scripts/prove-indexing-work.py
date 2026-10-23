#!/usr/bin/env python3
"""Require result/work assertions to catch indexing regressions and restore exact source."""
import argparse,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,default=ROOT/'docs/product-reset/evidence/2026-10-13-indexing-work/mutations-final')
OUT=p.parse_args().output;OUT.mkdir(parents=True,exist_ok=True)
JEST=['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','src/__tests__/indexing.work.sprint.test.ts']
FAULTS=[
 ('growing-array-scan','src/graph/indexer.ts','!pending.has(rel)','!changed.includes(rel)','large discovery'),
 ('missing-pending-add','src/graph/indexer.ts','          pending.add(rel);','          // fault: do not remember discovered path','large discovery'),
 ('ignore-known','src/graph/indexer.ts','!known.has(rel) && !pending.has(rel)','!pending.has(rel)','large discovery'),
 ('dedupe-existing-baseline','src/graph/indexer.ts','    const pending = new Set(changed);','    const pending = new Set(changed);\n    changed.splice(0, changed.length, ...pending);','large discovery'),
 ('split-whole-body','src/graph/static.analyzer.ts',"declaration.split('\\n', 1)","declaration.split('\\n')",'requests one bounded'),
 ('unbounded-source-selection','src/graph/static.analyzer.ts','const declaration = node.getText(sourceFile);','const declaration = sourceFile.getText(sourceFile);','requests one bounded'),
 ('retain-large-body','src/graph/static.analyzer.ts',"if (declaration.length > 4096) signature = Buffer.from(signature, 'utf16le').toString('utf16le');",'// fault: keep the signature view into the large source body','eight-MiB'),
 ('lossy-signature-copy','src/graph/static.analyzer.ts',"Buffer.from(signature, 'utf16le').toString('utf16le')","Buffer.from(signature, 'utf8').toString('utf8')",'source spans'),
 ('wrong-line-origin','src/graph/static.analyzer.ts','startLine: start.line + 1','startLine: start.line','source spans'),
 ('wrong-signature-limit','src/graph/static.analyzer.ts','firstLine.length > 200','firstLine.length > 199','source spans'),
]
results=[]
for name,rel,before,after,test in FAULTS:
 file=ROOT/rel;original=file.read_bytes();source=original.decode();assert source.count(before)==1,(name,source.count(before))
 try:
  file.write_text(source.replace(before,after))
  run=subprocess.run(JEST+['-t',test],cwd=ROOT,capture_output=True,text=True,timeout=45)
  log=run.stdout+run.stderr;(OUT/f'{name}.log').write_text(log)
  assertion='expect(received)' in log or 'expect(jest.fn())' in log
  invalid=any(s in log for s in ['Test suite failed to run','Exceeded timeout','Cannot find module','FATAL ERROR'])
  r={'fault':name,'exit':run.returncode,'assertion_caught':run.returncode!=0 and assertion and not invalid}
 finally:file.write_bytes(original)
 r.update(exact_restoration=file.read_bytes()==original,restored_sha256=hashlib.sha256(file.read_bytes()).hexdigest());results.append(r);print(json.dumps(r),flush=True)
run=subprocess.run(JEST,cwd=ROOT,capture_output=True,text=True,timeout=45);(OUT/'restored-baseline.log').write_text(run.stdout+run.stderr)
(OUT/'results.json').write_text(json.dumps({'faults':results,'restored_exit':run.returncode},indent=2)+'\n')
raise SystemExit(0 if run.returncode==0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
