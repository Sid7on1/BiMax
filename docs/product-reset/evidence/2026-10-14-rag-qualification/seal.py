"""Seal this completed qualification without changing production files or old evidence."""
from pathlib import Path
import datetime, difflib, hashlib, json, re
from dotenv import dotenv_values

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def write(name, value):
    with (OUT / name).open('x') as f: json.dump(value, f, indent=2); f.write('\n')
existing = [
    'src/memory/vector.store.ts', 'docs/product-reset/README.md',
    'docs/product-reset/competitive/05_GAP_REGISTER.md',
    'docs/product-reset/competitive/07_BUILD_SEQUENCE.md',
    'docs/product-reset/competitive/08_SOURCE_LEDGER.md',
    'docs/product-reset/competitive/examples/R02_RETRIEVAL_TRUTH.md',
]
scoped = existing + [
    'src/__tests__/rag.resources.test.ts',
    'scripts/bench-rag-resources.cjs', 'scripts/measure-rag-heap.cjs',
    'scripts/prove-rag-resources.py', 'scripts/prepare-rag-qualification.py',
    'scripts/rag-public-worker.cjs', 'scripts/lib/rag_public_grader.py',
    'scripts/rag-public-grader.test.py', 'scripts/bench-rag-public.py',
    'scripts/bench-rag-public-retrieval.py', 'scripts/summarize-rag-public-retrieval.py',
    'scripts/summarize-rag-public.py', 'scripts/check-rag-judge-rubrics.py',
    'docs/product-reset/96_RAG_RESOURCE_AND_PUBLIC_QUALIFICATION.md',
]
before = json.loads((OUT / 'dirty-before.json').read_text())
missing = [p for p in before if not (ROOT / p).is_file()]
changed = [p for p, digest in before.items() if (ROOT / p).is_file() and sha(ROOT / p) != digest]
unexpected = sorted(set(changed) - set(existing))
previous = []
for folder in ['2026-10-14-rag', '2026-10-13-context-work', '2026-10-13-context-orchestration']:
    prefix = 'docs/product-reset/evidence/' + folder + '/'
    manifest = json.loads((ROOT / prefix / 'manifest.json').read_text())
    internal = {p: digest for p, digest in manifest.items() if p.startswith(prefix)}
    invalid = [p for p, digest in internal.items() if not (ROOT / p).is_file() or sha(ROOT / p) != digest]
    previous.append({'folder': folder, 'internalArtifacts': len(internal), 'invalid': invalid})
config_before = json.loads((OUT / 'recovery-config-before.json').read_text())['sha256']
config_unchanged = all(sha(Path(p)) == digest for p, digest in config_before.items())
assert not missing and not unexpected and config_unchanged and not any(p['invalid'] for p in previous)
write('preservation-final.json', {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'startingDirtyFiles': len(before), 'changedStartingFiles': changed,
    'missing': missing, 'unexpectedChanges': unexpected,
    'previousRawEvidence': previous, 'globalConfigAndSecretsUnchanged': config_unchanged,
})
diff = ''.join(''.join(difflib.unified_diff((OUT / 'baseline' / p).read_text().splitlines(True),
              (ROOT / p).read_text().splitlines(True), fromfile='record-95/' + p, tofile='current/' + p)) for p in existing)
with (OUT / 'scoped.diff').open('x') as f: f.write(diff)
write('scope.json', {'modifiedAgainstFrozen95': existing, 'addedFiles': [p for p in scoped if p not in existing],
                     'productionChanges': ['src/memory/vector.store.ts'], 'commitPushInstall': False})
qualified = json.loads((OUT / 'public-answer-qualified.json').read_text())
assert qualified['all200Valid']
rubrics = json.loads((OUT / 'public-rubric-controls-1/results.json').read_text())
assert len(rubrics) == 5 and all(r['passed'] for r in rubrics)
run_status = []
for folder in sorted(OUT.iterdir()):
    if not folder.is_dir(): continue
    attempts = [json.loads(f.read_text()) for f in folder.glob('*-attempt-*.json')]
    if not attempts: continue
    results = [json.loads(f.read_text()) for f in folder.glob('*-result.json')]
    run_status.append({'run': folder.name, 'attempts': len(attempts),
                       'completionValid': sum(bool(a.get('valid')) for a in attempts),
                       'invalid': sum(not a.get('valid') for a in attempts),
                       'selectedQuestionResults': len(results),
                       'validSelectedQuestions': sum(bool(r.get('valid')) for r in results)})
write('public-provider-status-final.json', {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'supersedes': 'public-provider-status.json (preserved pre-recovery observation)',
    'qualifiedRun': 'public-answer-nemotron-4', 'qualifiedQuestions': 200,
    'reader': qualified['reader'], 'judge': qualified['judge'], 'runs': run_status,
    'rule': 'Pilot/control failures are not selected-question answer accuracy.',
})
credentials = dotenv_values(Path.home() / '.breakglass/.env')
secrets = [piece.encode() for name, value in credentials.items()
           if value and re.search(r'KEY|TOKEN|SECRET|PASSWORD', name, re.I)
           for piece in re.split(r'[\s,]+', value) if len(piece) >= 12]
leaks = [str(f.relative_to(ROOT)) for f in OUT.rglob('*') if f.is_file()
         and any(secret in f.read_bytes() for secret in secrets)]
assert not leaks, 'Credential scan found matches; redact before delivery'
write('credential-scan.json', {'filesChecked': sum(f.is_file() for f in OUT.rglob('*')),
                              'credentialValuesPrinted': False, 'matches': leaks})
files = [f for f in OUT.rglob('*') if f.is_file() and f.name != 'manifest.json'] + [ROOT / p for p in scoped]
write('manifest.json', {str(f.relative_to(ROOT)): sha(f) for f in sorted(set(files))})
print(json.dumps({'sealedFiles': len(set(files)), 'startingDirtyFilesPreserved': len(before) - len(changed),
                  'expectedChangedStartingFiles': changed, 'credentialMatches': len(leaks)}))
