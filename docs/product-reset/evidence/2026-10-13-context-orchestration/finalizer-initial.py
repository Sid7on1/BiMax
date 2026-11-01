from pathlib import Path
import hashlib
import json
import re
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
hash_of = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
owned = json.loads((OUT / 'owned-paths.json').read_text())
sources = json.loads((OUT / 'source-hashes.json').read_text())
assert all(hash_of(ROOT / rel) == digest for rel, digest in sources.items())
checks = json.loads((OUT / 'verification.json').read_text())
assert len(checks) == 11 and all(c['exit'] == 0 for c in checks)
mutants = json.loads((OUT / 'mutations-release/results.json').read_text())
assert len(mutants['faults']) == 26 and mutants['restored_exit'] == 0
fault_sources = {
    'undersized-reply-reserve': 'src/context/request.budget.ts',
    'lose-active-request': 'src/context/history.ts',
    'split-tool-exchange': 'src/context/history.ts',
    'attach-invalid-results': 'src/context/history.ts',
    'abort-is-unreadable': 'src/context/evidence.ts',
    'recall-ignores-stop': 'src/core/agent.loop.ts',
    'loop-drops-context-signal': 'src/core/agent.loop.ts',
    'aux-work-before-refusal': 'src/core/agent.loop.ts',
    'missing-seed-import-relation': 'src/tools/implementations/code.search.tool.ts',
}
for fault in mutants['faults']:
    rel = fault_sources.get(fault['fault'], 'src/memory/context.manager.ts')
    assert fault['assertion_caught'] and fault['exact_restoration'] and fault['restored_sha256'] == sources[rel], fault['fault']
before = json.loads(next((OUT / 'baseline/bench-v4').glob('*.json')).read_text())
after = json.loads(next((OUT / 'final-bench-qualified').glob('*.json')).read_text())
assert before['benchmark'] == after['benchmark'] == 'context-bench@4'
assert before['fixture_version'] == after['fixture_version']
assert before['validity']['valid'] and after['validity']['valid']
# The benchmark's family table must be read, not inferred from exit status.
before_results = {r['id']: r for r in before['results']}
after_results = {r['id']: r for r in after['results']}
assert before_results.keys() == after_results.keys()
families = {r['family'] for r in before_results.values()}
family_results = {}
for family in sorted(families):
    count = lambda rows: sum(r['outcome'] == 'pass' for r in rows.values() if r['family'] == family)
    family_results[family] = {'before': count(before_results), 'after': count(after_results)}
    assert count(after_results) >= count(before_results)
assert sum(r['outcome'] == 'pass' for r in before_results.values()) == 42
assert sum(r['outcome'] == 'pass' for r in after_results.values()) == 43
(OUT / 'benchmark-comparison.json').write_text(json.dumps({'version': after['benchmark'], 'same_fixture_version': True, 'families': family_results, 'no_family_decline': True}, indent=2) + '\n')
preservation = json.loads((OUT / 'dirty-preservation.json').read_text())
assert preservation['unexpected_or_unreconstructable'] == preservation['unowned_new_changes'] == []
assert preservation['initial_file_count'] == 636 and preservation['unchanged'] == 630
timings = json.loads((OUT / 'component-timings-field-cache.json').read_text())
assert timings['sourceHashes']['current'] == sources['src/memory/context.manager.ts']
assert all(r['discarded'] == 0 and len(r['samples']) == 36 for r in timings['results'])
qualification = {
    'product': 'Bimax coding engine source / staged engine, offline fixtures',
    'status': ['Implemented', 'Measured local prompt mechanics and component costs'],
    'live_provider_model': None, 'Jest_pass': 4341, 'Jest_suites_pass': 450,
    'existing_Jest_skips': 19, 'Bun_pass': 133, 'context_Bun_pass': 63, 'script_tests_pass': 3,
    'new_tests': 50, 'assertion_caught_source_faults': 26, 'context_benchmark_version': 'context-bench@4',
    'benchmark_before': '42/43', 'benchmark_after': '43/43', 'benchmark_family_decline': False,
    'engine_exchanges': 7, 'engine_outbound_bytes': 29470, 'lint_errors': 0, 'lint_warnings': 1841,
    'protected_initial_dirty_files': 636, 'byte_identical': 630, 'intentional_with_exact_baseline': 6,
    'initial_broad_run': 'unqualified: runner overrode fixture state roots; all failures retained',
    'initial_lint_error': 'repaired new test stub, no assertion changes',
    'installed_latency_RSS_energy_and_long_task_quality': 'Target/unmeasured',
    'provider_exact_token_image_and_lite_window_accounting': 'Target',
    'full_R01_R02_Product_ready_release_Win': 'Target', 'CU_UI_policy_changes': 'none',
    'commit_push_install': 'none',
    'guidance': ['README/01/05/06/08', 'Mac Buddy vision', 'playbook V03/V27B', 'competitive README/02/04/05/06/07', 'R01/R02', 'context records 47/50/51/59'],
    'missing_reference': 'competitive/03_CAPABILITY_MATRIX.md',
}
(OUT / 'qualification.json').write_text(json.dumps(qualification, indent=2) + '\n')
pattern = re.compile(rb'\b(?:nvapi-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AIza[A-Za-z0-9_-]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
files = [ROOT / p for p in owned] + [p for p in OUT.rglob('*') if p.is_file() and p.name not in {'manifest.json', 'secret-scan.json'}]
flags = [str(p.relative_to(ROOT)) for p in files if pattern.search(p.read_bytes())]
(OUT / 'secret-scan.json').write_text(json.dumps({'scope': 'Owned code/docs/evidence token-shaped strings and private-key markers; not an exhaustive audit', 'files': len(files), 'flagged_paths': flags}, indent=2) + '\n')
assert not flags, 'Inspect flagged paths privately before sharing evidence.'
manifest = {str(p.relative_to(ROOT)): hash_of(p) for p in files + [OUT / 'secret-scan.json', ROOT / 'app/engine/index.js']}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
assert all(hash_of(ROOT / p) == digest for p, digest in manifest.items())
subprocess.run(['git', 'diff', '--check', '--', *owned], cwd=ROOT, check=True)
print(json.dumps({'owned_paths': len(owned), 'artifact_hashes': len(manifest), 'assertion_caught_source_faults': 26, 'secret_pattern_flags': len(flags), 'all_final_checks': 'pass', 'commit_push': 'none'}))
