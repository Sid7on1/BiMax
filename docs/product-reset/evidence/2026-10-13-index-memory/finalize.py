from pathlib import Path
import json,hashlib,re
OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
owned=json.loads((OUT/'owned-paths.json').read_text())
checks=json.loads((OUT/'verification.json').read_text());assert len(checks)==10
assert {r['name']:r['exit'] for r in checks}=={'focused':0,'build':0,'app-typecheck':0,'lint':0,'full-jest':0,'full-bun':1,'node-scripts':0,'app-build':0,'engine-build':0,'engine-smoke':0}
compiler=json.loads((OUT/'mutations/results.json').read_text());deadline=json.loads((OUT/'deadline-mutations.json').read_text())
assert all(r['assertion_caught'] and r['exact_restoration'] for r in compiler['faults']+deadline['faults'])
assert compiler['restored_exit']==deadline['restored_exit']==0
source=json.loads((OUT/'source-hashes.json').read_text())
assert all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==h for p,h in source.items())
assert source['src/graph/static.analyzer.ts']==compiler['faults'][0]['restored_sha256']
assert source['src/utils/request.deadline.ts']==deadline['faults'][0]['restored_sha256']
pattern=re.compile(rb'\b(?:nvapi-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AIza[A-Za-z0-9_-]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
files=[ROOT/p for p in owned]+[p for p in OUT.rglob('*') if p.is_file() and p.name not in {'manifest.json','secret-scan.json'}]
flags=[str(p.relative_to(ROOT)) for p in files if pattern.search(p.read_bytes())]
(OUT/'secret-scan.json').write_text(json.dumps({'scope':'New owned source/docs and evidence only; token-shaped strings/private-key markers, not an exhaustive security audit','files':len(files),'flagged_paths':flags},indent=2)+'\n')
assert not flags, 'Inspect flagged file paths privately before sharing evidence'
manifest={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files+[OUT/'secret-scan.json',ROOT/'app/engine/index.js']}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
assert all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==h for p,h in manifest.items())
print(json.dumps({'owned_paths':len(owned),'manifest_files':len(manifest),'source_faults':11,'secret_pattern_flags':len(flags),'complete_offline_gate':'failed: repeated native OCR confidence contract'}))
