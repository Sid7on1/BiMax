from pathlib import Path
import hashlib,json,subprocess
out=Path(__file__).resolve().parent;root=out.parents[3]
baseline=json.loads((out/'initial-dirty-hashes.json').read_text());indexes={'docs/product-reset/README.md','docs/product-reset/competitive/05_GAP_REGISTER.md','docs/product-reset/competitive/07_BUILD_SEQUENCE.md','docs/product-reset/competitive/08_SOURCE_LEDGER.md'}
changes=[];unexpected=[];unchanged=0
for rel,h in baseline.items():
 data=(root/rel).read_bytes()
 if hashlib.sha256(data).hexdigest()==h:unchanged+=1;continue
 before=None;kind='unexpected'
 if rel in indexes:
  text=data.decode();a=text.index('\n## ')+1;b=text.index('\n## ',a)+1;before=(text[:a]+text[b:]).encode();kind='record 90 prefix only'
 elif rel=='docs/product-reset/competitive/examples/R02_RETRIEVAL_TRUTH.md':
  text=data.decode();a=text.index('## Graph operation performance — 2026-10-13');b=text.index('## Live-provider acceptance',a);before=(text[:a]+text[b:]).encode();kind='record 90 performance contract only'
 elif rel in {'src/graph/graph.store.ts','src/graph/sqlite.graph.store.ts'}:
  before=(out/'baseline'/rel).read_bytes();kind='intentional optimization; exact prior source frozen'
 good=before is not None and hashlib.sha256(before).hexdigest()==h
 changes.append({'path':rel,'change':kind,'prior_bytes_preserved_or_reconstructable':good})
 if not good:unexpected.append(rel)
report={'initial_file_count':len(baseline),'unchanged':unchanged,'intentional_changes':changes,'unexpected_or_unreconstructable':unexpected};(out/'dirty-preservation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));assert not unexpected
paths=subprocess.check_output(['git','ls-files','--modified','--others','--exclude-standard','-z'],cwd=root).decode().split('\0');owned={p for p in paths if p and p not in baseline and not p.startswith(str(out.relative_to(root))+'/')}|{c['path'] for c in changes}
(out/'owned-paths.json').write_text(json.dumps(sorted(owned),indent=2)+'\n');(out/'source-hashes.json').write_text(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in sorted(owned)},indent=2)+'\n')
assert (root/'src/utils/bounded.top.k.ts').read_bytes()==(out/'baseline/src/utils/bounded.top.k.ts').read_bytes()
