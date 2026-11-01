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
new = json.loads((OUT / 'mutations-qualified/results.json').read_text())
prior = json.loads((OUT / 'prior-mutants/results.json').read_text())
assert len(new['faults']) == 12 and len(prior['faults']) == 26 and new['restored_exit'] == prior['restored_exit'] == 0
for fault in new['faults']:
    assert fault['assertion_caught'] and fault['exact_restoration'] and fault['restored_sha256'] == hash_of(ROOT / fault['source']), fault['fault']
prior_sources = {
    'undersized-reply-reserve': 'src/context/request.budget.ts',
    'lose-active-request': 'src/context/history.ts', 'split-tool-exchange': 'src/context/history.ts',
    'attach-invalid-results': 'src/context/history.ts', 'abort-is-unreadable': 'src/context/evidence.ts',
    'recall-ignores-stop': 'src/core/agent.loop.ts', 'loop-drops-context-signal': 'src/core/agent.loop.ts',
    'aux-work-before-refusal': 'src/core/agent.loop.ts', 'missing-seed-import-relation': 'src/tools/implementations/code.search.tool.ts',
}
for fault in prior['faults']:
    rel = prior_sources.get(fault['fault'], 'src/memory/context.manager.ts')
    assert fault['assertion_caught'] and fault['exact_restoration'] and fault['restored_sha256'] == hash_of(ROOT / rel), fault['fault']
baseline = json.loads(next((OUT / 'baseline/bench').glob('*.json')).read_text())
final = json.loads(next((OUT / 'final-bench').glob('*.json')).read_text())
assert baseline['validity']['valid'] and final['validity']['valid']
assert baseline['benchmark'] == final['benchmark'] == 'context-bench@4'
assert baseline['fixture_version'] == final['fixture_version']
assert {c['id'] for c in baseline['cases']} == {c['id'] for c in final['cases']}
families = {}
for family in sorted({c['family'] for c in baseline['cases']}):
    passed = lambda run: sum(c['outcome'] == 'pass' for c in run['cases'] if c['family'] == family)
    families[family] = {'before': passed(baseline), 'after': passed(final)}
    assert passed(final) >= passed(baseline)
assert sum(c['outcome'] == 'pass' for c in baseline['cases']) == sum(c['outcome'] == 'pass' for c in final['cases']) == 43
(OUT / 'benchmark-comparison.json').write_text(json.dumps({'same_fixture': True, 'version': final['benchmark'], 'families': families, 'before': '43/43', 'after': '43/43', 'no_family_decline': True}, indent=2) + '\n')
timings = json.loads((OUT / 'timings-summary.json').read_text())
assert len(timings['results']) == 12 and all(r['samplesPerVersion'] == 36 and r['discarded'] == 0 for r in timings['results'])
for rel in ['src/memory/context.manager.ts', 'src/context/continuation.ts']:
    assert timings['sourceHashes']['current:' + rel] == hash_of(ROOT / rel)
    assert timings['sourceHashes']['baseline:' + rel] == hash_of(OUT / 'baseline' / rel)
for suffix in ['a', 'b']:
    run = json.loads((OUT / f'timings-qualified-{suffix}.json').read_text())
    assert run['sourceHashes'] == timings['sourceHashes']
    assert all(r['discarded'] == 0 and len(r['samples']) == 36 for r in run['results'])
(OUT / 'timing-fixtures.json').write_text(json.dumps({'qualified_runs': 2, 'exploratory_runs_retained': 1, 'qualified_shapes': 12, 'exploratory_shapes': 11, 'qualified_samples_per_version_per_shape': 36, 'discarded_qualified_samples': 0, 'current_benchmark_script_sha256': hash_of(ROOT / 'scripts/bench-context-work.cjs'), 'reconstructed_exploratory_script_sha256': hash_of(OUT / 'benchmark-initial.cjs')}, indent=2) + '\n')
preservation = json.loads((OUT / 'dirty-preservation.json').read_text())
assert preservation['initial_file_count'] == 695 and preservation['unchanged'] == 688
assert preservation['unexpected_or_unreconstructable'] == preservation['unowned_new_changes'] == preservation['prior_artifacts_changed'] == []
assert preservation['prior_record_93_artifacts_checked'] == 191
qualification = {
    'product': 'Bimax coding engine source/staged engine, local generated fixtures',
    'status': ['Implemented', 'Measured local preparation costs with identical outputs'],
    'live_provider_model': None, 'fixture_provider': 'deterministic local summarizer',
    'Jest_pass': 4364, 'Jest_suites_pass': 451, 'existing_Jest_skips': 19,
    'Bun_pass': 133, 'context_Bun_pass': 63, 'script_tests_pass': 3, 'new_tests': 23,
    'new_assertion_caught_faults': 12, 'prior_context_faults_rechecked': 26,
    'context_benchmark': 'context-bench@4, 43/43 before and after; no family decline',
    'engine_exchanges': 7, 'engine_outbound_bytes': 29460, 'lint_errors': 0, 'lint_warnings': 1847,
    'qualified_timing_runs': 2, 'samples_per_version_per_shape': 36, 'discarded_qualified_samples': 0,
    'earlier_exploratory_timing_run': 'retained separately; eleven rather than twelve shapes',
    'initial_proof_attempt': 'two surviving tests strengthened; no assertions loosened',
    'initial_loader_attempt': 'invalid compile/loader failure, retained, not counted as a fault kill',
    'protected_initial_dirty_files': 695, 'byte_identical': 688, 'exact_baseline_for_intentional_changes': 7,
    'prior_raw_artifacts_unchanged': 191, 'CU_UI_implementation_changes': 'none', 'commit_push_install': 'none',
    'whole_app_provider_latency_quality_RSS_energy_release_Win': 'Target/unmeasured',
    'guidance': ['README/01/05/06/08', 'Mac Buddy performance vision', 'playbook V03/V27B', 'competitive README/06', 'C01/R01/R02', 'context record 93'],
}
(OUT / 'qualification.json').write_text(json.dumps(qualification, indent=2) + '\n')
pattern = re.compile(rb'\b(?:nvapi-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AIza[A-Za-z0-9_-]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
files = [ROOT / p for p in owned] + [p for p in OUT.rglob('*') if p.is_file() and p.name not in {'manifest.json', 'secret-scan.json'}]
flags = [str(p.relative_to(ROOT)) for p in files if pattern.search(p.read_bytes())]
(OUT / 'secret-scan.json').write_text(json.dumps({'scope': 'Owned code/docs/evidence token-shaped strings and private-key markers; not exhaustive', 'files': len(files), 'flagged_paths': flags}, indent=2) + '\n')
assert not flags, 'Inspect flagged paths privately before sharing evidence.'
manifest = {str(p.relative_to(ROOT)): hash_of(p) for p in files + [OUT / 'secret-scan.json', ROOT / 'app/engine/index.js']}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
assert all(hash_of(ROOT / p) == digest for p, digest in manifest.items())
subprocess.run(['git', 'diff', '--check', '--', *owned], cwd=ROOT, check=True)
print(json.dumps({'owned_paths': len(owned), 'artifact_hashes': len(manifest), 'assertion_caught_source_faults': 38, 'secret_pattern_flags': len(flags), 'all_final_checks': 'pass', 'commit_push': 'none'}))
