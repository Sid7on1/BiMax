"""Dependency closure of the archived Computer Use trust layer: follow relative imports from the entry points."""
import os, re, sys, json
ROOT = os.path.expanduser('~/Developer/bimax-archive/src')
ENTRIES = ['computer/action.contract.ts', 'computer/action.receipt.ts', 'computer/action.evidence.ts',
           'computer/verification.ts', 'computer/takeover.authority.ts', 'computer/native.input.interlock.ts',
           'computer/adhoc.approval.store.ts']
IMPORT = re.compile(r"""(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}/[^'"]+)['"]|import\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""")
def resolve(base, spec):
    p = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    for cand in (p, p + '.ts', p + '.tsx', os.path.join(p, 'index.ts')):
        if os.path.isfile(os.path.join(ROOT, cand)): return cand
    return None
seen, todo, missing = set(), list(ENTRIES), []
while todo:
    f = todo.pop()
    if f in seen: continue
    seen.add(f)
    src = open(os.path.join(ROOT, f)).read()
    for a, b in IMPORT.findall(src):
        r = resolve(f, a or b)
        if r: todo.append(r)
        else: missing.append((f, a or b))
by_dir = {}
for f in sorted(seen): by_dir.setdefault(os.path.dirname(f), []).append(f)
lines = sum(sum(1 for _ in open(os.path.join(ROOT, f))) for f in seen)
print(f'{len(seen)} files, {lines} lines; unresolved imports: {len(missing)}')
for d, fs in sorted(by_dir.items()): print(f'  {d or "."}: {len(fs)}  ' + ', '.join(os.path.basename(x) for x in fs[:12]) + (' …' if len(fs) > 12 else ''))
json.dump({'entries': ENTRIES, 'files': sorted(seen), 'lines': lines, 'unresolved': missing},
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'trust-layer-closure.json'), 'w'), indent=1)
