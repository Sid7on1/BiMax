#!/usr/bin/env python3
"""Inject compiler-retention/result faults, require assertion failures, restore exact source."""
import argparse,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,default=ROOT/'docs/product-reset/evidence/2026-10-13-index-memory/mutations')
OUT=p.parse_args().output;OUT.mkdir(parents=True,exist_ok=True)
FILE=ROOT/'src/graph/static.analyzer.ts'
JEST=['node','node_modules/jest/bin/jest.js','--coverage=false','--runInBand','src/__tests__/compiler.lifetime.sprint.test.ts']
FAULTS=[
 ('retain-full-program','const program = this.createProgram();\n    const typeChecker', 'const program = this.createProgram();\n    Object.assign(this, { retainedCompiler: program });\n    const typeChecker','after full while'),
 ('retain-single-checker','const program = snapshot ?? this.createProgram();\n    const typeChecker = program.getTypeChecker();', 'const program = snapshot ?? this.createProgram();\n    const typeChecker = program.getTypeChecker();\n    Object.assign(this, { retainedChecker: typeChecker });','after single while'),
 ('retain-shared-snapshot','const program = snapshot ?? this.createProgram();','const program = snapshot ?? this.createProgram();\n    if (snapshot) Object.assign(this, { retainedSnapshot: snapshot });','after shared while'),
 ('retain-failed-lookup','if (!sourceFile) {\n      throw new Error', 'if (!sourceFile) {\n      Object.assign(this, { failedCompiler: program });\n      throw new Error','after missing while'),
 ('retain-failed-checker','extractor.extractEdges(sourceFile, typeChecker);','try { extractor.extractEdges(sourceFile, typeChecker); } catch (error) { Object.assign(this, { failedChecker: typeChecker }); throw error; }','after checker-failure while'),
 ('lose-call-resolution','const signature = typeChecker.getResolvedSignature(node);','const signature = undefined as ts.Signature | undefined;','exactly match'),
 ('lose-variable-resolution','const symbol = typeChecker.getSymbolAtLocation(node);','const symbol = undefined as ts.Symbol | undefined;','exactly match'),
 ('skip-publication','publishFileGraph(this.store, relPath, replacement.getGraph());','// fault: parsed replacement is never published','subsequent parse'),
]
results=[]
original=FILE.read_bytes();source=original.decode()
for name,before,after,test in FAULTS:
 if source.count(before)!=1:raise RuntimeError(f'{name}: marker count {source.count(before)}')
 try:
  FILE.write_text(source.replace(before,after))
  run=subprocess.run(JEST+['-t',test],cwd=ROOT,capture_output=True,text=True,timeout=45)
  log=run.stdout+run.stderr;(OUT/f'{name}.log').write_text(log)
  invalid=any(s in log for s in ['Test suite failed to run','Exceeded timeout','Cannot find module','FATAL ERROR'])
  result={'fault':name,'exit':run.returncode,'assertion_caught':run.returncode!=0 and 'expect(received)' in log and not invalid}
 finally:FILE.write_bytes(original)
 result.update(exact_restoration=FILE.read_bytes()==original,restored_sha256=hashlib.sha256(FILE.read_bytes()).hexdigest())
 results.append(result);print(json.dumps(result),flush=True)
run=subprocess.run(JEST,cwd=ROOT,capture_output=True,text=True,timeout=45)
(OUT/'restored-baseline.log').write_text(run.stdout+run.stderr)
(OUT/'results.json').write_text(json.dumps({'faults':results,'restored_exit':run.returncode},indent=2)+'\n')
raise SystemExit(0 if run.returncode==0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
