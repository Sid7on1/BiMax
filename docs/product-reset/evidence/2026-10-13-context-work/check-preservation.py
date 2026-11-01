from pathlib import Path
import hashlib
import json
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
hash_of = lambda data: hashlib.sha256(data).hexdigest()
before = json.loads((OUT / 'dirty-before.json').read_text())
docs = json.loads((OUT / 'doc-additions.json').read_text())
owned = {
    'src/memory/context.manager.ts', 'src/context/continuation.ts',
    'src/__tests__/context.work.sprint.test.ts',
    'scripts/bench-context-work.cjs', 'scripts/prove-context-work.py',
    'scripts/prove-context-orchestration.py', 'docs/product-reset/94_LESS_CONTEXT_WORK.md', *docs.keys(),
}
changes, unexpected = [], []
unchanged = 0
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
proof = 'scripts/prove-context-orchestration.py'
old_proof = (OUT / 'baseline' / proof).read_text()
assert old_proof.replace('const encoded = messages.map(m => JSON.stringify(m));', 'const encoded = messages.map(m => serializeSummaryMessage(m, limitChars));') == (ROOT / proof).read_text()
paths = subprocess.check_output(['git', 'ls-files', '--modified', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
unowned = [p for p in paths if p and p not in before and p not in owned and not p.startswith(str(OUT.relative_to(ROOT)) + '/')]
prior_root = 'docs/product-reset/evidence/2026-10-13-context-orchestration/'
prior_manifest = json.loads((ROOT / prior_root / 'manifest.json').read_text())
prior_artifacts = {rel: digest for rel, digest in prior_manifest.items() if rel.startswith(prior_root)}
prior_changed = [rel for rel, digest in prior_artifacts.items() if hash_of((ROOT / rel).read_bytes()) != digest]
report = {'initial_file_count': len(before), 'unchanged': unchanged, 'intentional_changes': changes, 'unexpected_or_unreconstructable': unexpected, 'unowned_new_changes': unowned, 'prior_record_93_artifacts_checked': len(prior_artifacts), 'prior_artifacts_changed': prior_changed}
(OUT / 'dirty-preservation.json').write_text(json.dumps(report, indent=2) + '\n')
assert not unexpected and not unowned and not prior_changed, report
assert not subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=ROOT).strip()
(OUT / 'owned-paths.json').write_text(json.dumps(sorted(owned), indent=2) + '\n')
(OUT / 'source-hashes.json').write_text(json.dumps({rel: hash_of((ROOT / rel).read_bytes()) for rel in sorted(owned)}, indent=2) + '\n')
print(json.dumps(report, indent=2))
