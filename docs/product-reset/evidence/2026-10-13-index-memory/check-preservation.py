from pathlib import Path
import hashlib,json,subprocess
OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[3]
baseline=json.loads((OUT/'initial-dirty-hashes.json').read_text())
indexes={'docs/product-reset/README.md','docs/product-reset/competitive/05_GAP_REGISTER.md','docs/product-reset/competitive/07_BUILD_SEQUENCE.md','docs/product-reset/competitive/08_SOURCE_LEDGER.md'}
changes=[];unexpected=[];unchanged=0
for rel,digest in baseline.items():
 file=ROOT/rel;data=file.read_bytes() if file.is_file() else b''
 if hashlib.sha256(data).hexdigest()==digest:unchanged+=1;continue
 before=None;kind='unexpected'
 if rel in indexes:
  text=data.decode();a=text.index('\n## ')+1;b=text.index('\n## ',a)+1;before=(text[:a]+text[b:]).encode();kind='record 91 prefix only'
 elif rel=='docs/product-reset/competitive/examples/R02_RETRIEVAL_TRUTH.md':
  text=data.decode();a=text.index('## Compiler lifetime contract — 2026-10-13');b=text.index('## Live-provider acceptance',a);before=(text[:a]+text[b:]).encode();kind='record 91 contract only'
 elif rel=='src/graph/static.analyzer.ts':
  before=(OUT/'baseline'/rel).read_bytes();kind='intentional compiler ownership change; exact starting bytes frozen'
 good=before is not None and hashlib.sha256(before).hexdigest()==digest
 changes.append({'path':rel,'change':kind,'prior_bytes_preserved_or_reconstructable':good})
 if not good:unexpected.append(rel)
report={'initial_file_count':len(baseline),'unchanged':unchanged,'intentional_changes':changes,'unexpected_or_unreconstructable':unexpected}
(OUT/'dirty-preservation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));assert not unexpected
paths=subprocess.check_output(['git','ls-files','--modified','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
owned={p for p in paths if p and p not in baseline and not p.startswith(str(OUT.relative_to(ROOT))+'/')}|{c['path'] for c in changes}
(OUT/'owned-paths.json').write_text(json.dumps(sorted(owned),indent=2)+'\n')
(OUT/'source-hashes.json').write_text(json.dumps({p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sorted(owned)},indent=2)+'\n')
for rel in ['src/graph/graph.store.ts','src/graph/file.graph.ts']:
 assert (ROOT/rel).read_bytes()==(OUT/'baseline'/rel).read_bytes()
assert not subprocess.check_output(['git','diff','--cached','--name-only'],cwd=ROOT).strip()
