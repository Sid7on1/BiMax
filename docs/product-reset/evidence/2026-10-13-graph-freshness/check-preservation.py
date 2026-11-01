from pathlib import Path
import hashlib,json,subprocess
out=Path(__file__).resolve().parent
root=out.parents[3]
baseline=json.loads((out/'initial-dirty-hashes.json').read_text());results=[]
indexes={'docs/product-reset/README.md','docs/product-reset/competitive/05_GAP_REGISTER.md','docs/product-reset/competitive/07_BUILD_SEQUENCE.md','docs/product-reset/competitive/08_SOURCE_LEDGER.md'}
for name,old in baseline.items():
 p=root/name;raw=p.read_bytes();current=hashlib.sha256(raw).hexdigest();kind='unchanged';restored=raw
 if current!=old:
  text=raw.decode()
  if name in indexes:
   a=text.index('\n## ')+1;b=text.index('\n## ',a)+1;restored=(text[:a]+text[b:]).encode();kind='new record 89 prefix'
  elif name=='src/__tests__/agent.loop.clarification.test.ts':
   restored=text.replace('{ /* Fixture body intentionally performs no work. */ }','{}').encode();kind='comments in intentionally empty fixture blocks only'
  else:kind='UNEXPECTED'
 results.append({'path':name,'change':kind,'prior_bytes_preserved_or_reconstructable':hashlib.sha256(restored).hexdigest()==old})
report={'initial_file_count':len(baseline),'unchanged':sum(r['change']=='unchanged' for r in results),'intentional_changed':[r for r in results if r['change']!='unchanged'],'unexpected_or_unreconstructable':[r for r in results if not r['prior_bytes_preserved_or_reconstructable']]}
(out/'dirty-preservation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));assert not report['unexpected_or_unreconstructable']
paths=subprocess.check_output(['git','ls-files','--modified','--others','--exclude-standard','-z'],cwd=root).decode().split('\0');owned=[p for p in paths if p and p not in baseline and not p.startswith(str(out.relative_to(root))+'/')];owned += list(indexes)+['src/__tests__/agent.loop.clarification.test.ts'];(out/'owned-paths.json').write_text(json.dumps(sorted(set(owned)),indent=2)+'\n')
(out/'source-hashes.json').write_text(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in sorted(set(owned)) if (root/p).is_file()},indent=2)+'\n')
print('Owned files outside evidence:',len(set(owned)))
