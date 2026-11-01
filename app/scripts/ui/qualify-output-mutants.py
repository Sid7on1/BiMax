#!/usr/bin/env python3
"""Sequential isolated source faults. Restore exact starting bytes even when a grader fails."""
import subprocess,pathlib,hashlib,json
root=pathlib.Path(__file__).resolve().parents[3]
evidence=root/'docs/product-reset/evidence/2026-10-19-rich-outputs/mutations';evidence.mkdir(parents=True,exist_ok=True)
cases=[
 ('foreign-owner','app/src/main/outputs.store.ts','record.ownerThreadId !== owner','false','app/src/__tests__/outputs.store.test.ts'),
 ('stale-version','app/src/main/outputs.store.ts',"record.versions.at(-1)!.id !== input.baseVersion",'false','app/src/__tests__/outputs.store.test.ts'),
 ('altered-bytes','app/src/main/outputs.store.ts','hash(content) === version.sha256 && Buffer.byteLength(content) === version.byteLength','true','app/src/__tests__/outputs.store.test.ts'),
 ('cancelled-publication','app/src/main/outputs.store.ts','if (!admitted())','if (false)','app/src/__tests__/outputs.store.test.ts'),
 ('active-image-format','src/protocol/presentation.ts',r'image\/gif)$',r'image\/gif|image\/svg\+xml)$','src/__tests__/presentation.test.ts'),
 ('foreign-ui-tool','src/mcp/client.ts','name!==t.name','false','src/__tests__/mcp.ui.test.ts'),
 ('pricing-progress','app/src/renderer/src/engine.state.ts','return { ...state, notices: { ...state.notices, [notice.id]: notice } };','return { ...state, status: notice.text };','app/src/__tests__/engine.store.test.ts'),
 ('revoked-ui-grant','src/mcp/ui.grants.ts','grants.delete(id);','void id;','src/__tests__/presentation.test.ts'),
]
report=[]
for name,file,before,after,test in cases:
 target=root/file;original=target.read_bytes();text=original.decode();assert before in text,(name,before)
 try:
  target.write_text(text.replace(before,after));p=subprocess.run(['npx','jest','--runInBand','--coverage=false','--runTestsByPath',test],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
  output=p.stdout.decode(errors='replace');(evidence/(name+'.log')).write_text(output)
  caught=p.returncode!=0 and 'Test Suites:' in output and ('● ' in output) and 'Test suite failed to run' not in output
  report.append(dict(name=name,caught=caught,exitCode=p.returncode,source=file,sha256=hashlib.sha256(original).hexdigest()))
 finally:
  target.write_bytes(original)
 assert target.read_bytes()==original
 (evidence/'results.json').write_text(json.dumps(report,indent=2))
 print(name,report[-1]['caught'],flush=True)
assert all(r['caught'] for r in report)
