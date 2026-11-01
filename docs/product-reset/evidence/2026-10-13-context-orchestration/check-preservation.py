from pathlib import Path
import hashlib
import json
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
hash_of = lambda data: hashlib.sha256(data).hexdigest()
before = {item['path']: item['sha256'] for item in json.loads((OUT / 'dirty-before.json').read_text())}
docs = json.loads((OUT / 'doc-additions.json').read_text())
owned = {
    'src/context/history.ts', 'src/context/request.budget.ts', 'src/context/evidence.ts',
    'src/memory/context.manager.ts', 'src/memory/recall.ts', 'src/core/agent.loop.ts',
    'src/tools/implementations/code.search.tool.ts',
    'src/__tests__/context.request.budget.test.ts', 'src/__tests__/context.orchestration.sprint.test.ts',
    'scripts/prove-context-orchestration.py', 'scripts/bench-context-orchestration.cjs',
    'benchmarks/context/cases.ts', 'benchmarks/context/DESIGN.md',
    'docs/product-reset/93_CONTEXT_ORCHESTRATION.md', *docs.keys(),
}
changes = []
unchanged = 0
unexpected = []
for rel, digest in before.items():
    file = ROOT / rel
    if file.is_file() and hash_of(file.read_bytes()) == digest:
        unchanged += 1
        continue
    frozen = OUT / 'baseline' / rel
    preserved = rel in owned and frozen.is_file() and hash_of(frozen.read_bytes()) == digest
    changes.append({'path': rel, 'prior_bytes_frozen_exactly': preserved})
    if not preserved:
        unexpected.append(rel)
for rel, block in docs.items():
    original = (OUT / 'baseline' / rel).read_text()
    first, rest = original.split('\n', 1)
    assert (ROOT / rel).read_text() == first + '\n\n' + block + rest.lstrip('\n'), rel
paths = subprocess.check_output(['git', 'ls-files', '--modified', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
unowned = [p for p in paths if p and p not in before and p not in owned and not p.startswith(str(OUT.relative_to(ROOT)) + '/')]
report = {'initial_file_count': len(before), 'unchanged': unchanged, 'intentional_changes': changes, 'unexpected_or_unreconstructable': unexpected, 'unowned_new_changes': unowned}
(OUT / 'dirty-preservation.json').write_text(json.dumps(report, indent=2) + '\n')
assert not unexpected and not unowned, report
assert not subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=ROOT).strip(), 'No staging was authorized in this round.'
(OUT / 'owned-paths.json').write_text(json.dumps(sorted(owned), indent=2) + '\n')
(OUT / 'source-hashes.json').write_text(json.dumps({rel: hash_of((ROOT / rel).read_bytes()) for rel in sorted(owned)}, indent=2) + '\n')
print(json.dumps(report, indent=2))
