#!/usr/bin/env python3
"""Qualify memory/bot guards in disposable source copies; never mutate the user's checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
OUT = args.output.resolve()
OUT.mkdir(parents=True, exist_ok=False)
TESTS = ['src/__tests__/memory.integrity.test.ts', 'src/__tests__/memory.retrieval.factory.test.ts', 'src/__tests__/bots.foundation.test.ts']
FAULTS = [
    ('no-shared-write-reservation', 'src/memory/write.transaction.ts', [('BEGIN IMMEDIATE', 'BEGIN DEFERRED')], TESTS[0], 'writers retain'),
    ('ignore-backfill-generation', 'src/memory/vector.store.ts', [('doc.generation !== item.generation', 'false')], TESTS[0], 'generation: aba'),
    ('ignore-versionless-source', 'src/memory/vector.store.ts', [('doc.metadata.content !== item.documentText', 'false'), ('chunk.text !== item.text', 'false')], TESTS[0], 'versionless source'),
    ('skip-publication-reload', 'src/memory/vector.store.ts', [('withMemoryWriteTransaction(this.STORE_PATH, async () => {\n      await this.loadStore(true);', 'withMemoryWriteTransaction(this.STORE_PATH, async () => {')], TESTS[0], 'generation: other-instance'),
    ('retain-failed-write-cache', 'src/memory/vector.store.ts', [('// A rejected write must not leave a cache identity that can later republish ghost edits.\n        this.diskIdentity = null;', '// fault: keep failed mutation cache identity')], TESTS[0], 'unacknowledged note'),
    ('ignore-configured-embedding-route', 'src/memory/retrieval.factory.ts', [('resolve: async () => settings.embeddingBaseURL', 'resolve: async () => false')], TESTS[1], 'real worker'),
    ('drop-local-reranker-composition', 'src/memory/retrieval.factory.ts', [("const localReranker = (options.localRerank ?? process.env.BIMAX_LOCAL_RERANK === '1') ? new LocalReranker() : null;", 'const localReranker = null;')], TESTS[1], 'local reranker'),
    ('widen-bot-authority', 'src/bots/worker.policy.ts', [('!FOUNDATION_BOT_TOOLS.has(name) || !run.grantedTools.includes(name)', 'false')], TESTS[2], 'cannot authorize|missing host grant'),
    ('keep-forbidden-executable-tools', 'src/bots/worker.policy.ts', [('if (!allowed.has(name)) registry.unregister(name);', 'if (false) registry.unregister(name);')], TESTS[2], 'actual registry'),
    ('ignore-handoff-budget', 'src/bots/context.ts', [('const budget = Math.min(bot.handoffTokenBudget, hostTokenBudget);', 'const budget = Number.MAX_SAFE_INTEGER;')], TESTS[2], 'context keeps fixed'),
    ('share-all-bot-memory', 'src/bots/worker.policy.ts', [("path.join(run.catalogDirectory, 'memory', run.definition.id, 'vectors.json')", "path.join(run.catalogDirectory, 'memory', 'shared', 'vectors.json')")], TESTS[2], 'parallel real workers'),
    ('ignore-catalog-revision', 'src/bots/catalog.ts', [('at < 0 || rows[at].revision !== expectedRevision', 'at < 0')], TESTS[2], 'concurrent profile edits'),
    ('replace-inherited-spend-budget', 'src/bots/service.ts', [('activeRunBudget() ?? createRunBudget()', 'createRunBudget()')], TESTS[2], 'parallel real workers'),
    ('multiply-workspace-worker-pools', 'src/bots/service.ts', [("process.env.BIMAX_AGENT_CAPACITY_PATH || path.join(this.catalog.directory, 'worker-capacity.json')", 'undefined')], TESTS[2], 'different bot workspaces'),
]

sha = lambda value: hashlib.sha256(value).hexdigest()
protected = {relative: (ROOT / relative).read_bytes() for relative in {fault[1] for fault in FAULTS}}
results = []
with tempfile.TemporaryDirectory(prefix='bimax-memory-proof-') as scratch:
    work = Path(scratch)
    shutil.copytree(ROOT / 'src', work / 'src')
    for file in ['tsconfig.json', 'jest.setup.ts']:
        shutil.copy2(ROOT / file, work / file)
    (work / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    (work / 'jest.config.cjs').write_text("module.exports = {preset:'ts-jest',testEnvironment:'node',roots:['<rootDir>/src'],setupFiles:['<rootDir>/jest.setup.ts'],testMatch:['**/*.test.ts'],collectCoverage:false};\n")
    env = {**os.environ, 'BIMAX_TEST_SOURCE_ROOT': str(work), 'BIMAX_STATE_DIR': str(work / 'state'),
           'BIMAX_BREAKGLASS_DIR': str(work / 'config'), 'BIMAX_KEY_LEDGER_PATH': 'memory'}
    base = ['node', str(ROOT / 'node_modules/jest/bin/jest.js'), '--config', str(work / 'jest.config.cjs'), '--runInBand']
    def execute(name, tests, pattern=None):
        command = base + tests + (['-t', pattern] if pattern else [])
        run = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=90)
        log = run.stdout + run.stderr
        (OUT / f'{name}.log').write_text(log)
        assertion = 'expect(received)' in log or 'expect(jest.fn())' in log
        invalid = any(marker in log for marker in ['Test suite failed to run', 'Exceeded timeout', 'FATAL ERROR', 'Cannot find module'])
        return {'exitCode': run.returncode, 'assertionFailure': assertion, 'invalid': invalid}
    baseline = execute('current-baseline', TESTS)
    assert baseline['exitCode'] == 0, baseline
    for name, relative, edits, test, pattern in FAULTS:
        file = work / relative
        original = file.read_bytes()
        changed = original.decode()
        for before, after in edits:
            assert changed.count(before) == 1, (name, before, changed.count(before))
            changed = changed.replace(before, after)
        try:
            file.write_text(changed)
            observed = execute(name, [test], pattern)
        finally:
            file.write_bytes(original)
        result = {'fault': name, 'source': relative, **observed,
                  'assertionCaught': observed['exitCode'] != 0 and observed['assertionFailure'] and not observed['invalid'],
                  'copyRestoredExactly': file.read_bytes() == original}
        results.append(result)
        (OUT / 'progress.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(result), flush=True)
    restored = execute('restored', TESTS)
    # Reproduce the frozen starting store with the new regression assertions, in the copy only.
    file = work / 'src/memory/vector.store.ts'
    current = file.read_bytes()
    try:
        file.write_bytes((ROOT / 'docs/product-reset/evidence/2026-10-18-memory-integrity-bots/baseline/src/memory/vector.store.ts').read_bytes())
        starting = execute('frozen-starting-store', [TESTS[0]])
    finally:
        file.write_bytes(current)
unchanged = {relative: sha((ROOT / relative).read_bytes()) == sha(content) for relative, content in protected.items()}
report = {'faults': results, 'currentBaseline': baseline, 'restored': restored, 'frozenStartingStore': starting,
          'workingTreeSourceUnchanged': unchanged}
(OUT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
raise SystemExit(0 if restored['exitCode'] == 0 and all(item['assertionCaught'] and item['copyRestoredExactly'] for item in results)
                 and starting['exitCode'] != 0 and starting['assertionFailure'] and all(unchanged.values()) else 1)
