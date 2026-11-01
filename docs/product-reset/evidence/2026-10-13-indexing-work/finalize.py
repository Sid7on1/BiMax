from pathlib import Path
import json,hashlib,re,subprocess
OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
owned=json.loads((OUT/'owned-paths.json').read_text());checks=json.loads((OUT/'verification.json').read_text())
assert len(checks)==10 and all(r['exit']==0 for r in checks)
current=json.loads((OUT/'source-hashes.json').read_text())
assert all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==digest for p,digest in current.items())
new=json.loads((OUT/'mutations-final/results.json').read_text());old=json.loads((OUT/'compiler-mutant-recheck-final/results.json').read_text())
assert len(new['faults'])==10 and len(old['faults'])==8
assert new['restored_exit']==old['restored_exit']==0
assert all(r['assertion_caught'] and r['exact_restoration'] for r in new['faults']+old['faults'])
for i,r in enumerate(new['faults']):assert r['restored_sha256']==current['src/graph/indexer.ts' if i<4 else 'src/graph/static.analyzer.ts']
for r in old['faults']:assert r['restored_sha256']==current['src/graph/static.analyzer.ts']
assert json.loads((OUT/'dirty-preservation.json').read_text())['unexpected_or_unreconstructable']==[]
source_hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT/'src/graph/indexer.ts',ROOT/'src/graph/static.analyzer.ts',OUT/'baseline/src/graph/indexer.ts',OUT/'baseline/src/graph/static.analyzer.ts']}
(OUT/'benchmark-sources.json').write_text(json.dumps({'scope':'Final production source matches exact restored source-fault hashes; frozen starting sources and intermediate candidate sources are separate','sha256':source_hashes},indent=2)+'\n')
pattern=re.compile(rb'\b(?:nvapi-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AIza[A-Za-z0-9_-]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
files=[ROOT/p for p in owned]+[p for p in OUT.rglob('*') if p.is_file() and p.name not in {'manifest.json','secret-scan.json'}]
flags=[str(p.relative_to(ROOT)) for p in files if pattern.search(p.read_bytes())]
(OUT/'secret-scan.json').write_text(json.dumps({'scope':'New owned source/docs and evidence only; token-shaped strings/private-key markers, not an exhaustive security audit','files':len(files),'flagged_paths':flags},indent=2)+'\n')
assert not flags,'Inspect flagged file paths privately before sharing evidence'
manifest={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files+[OUT/'secret-scan.json',ROOT/'app/engine/index.js']}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
assert all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==digest for p,digest in manifest.items())
subprocess.run(['git','diff','--check','--',*owned],cwd=ROOT,check=True)
print(json.dumps({'owned_paths':len(owned),'artifact_hashes':len(manifest),'assertion_caught_source_faults':18,'secret_pattern_flags':len(flags),'all_final_checks':'pass','commit_push':'none'}))
