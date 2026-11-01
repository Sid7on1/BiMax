"""Reintroduce persistence defects only in disposable source copies; require assertion failures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/product-reset/evidence/2026-10-31-persistence-repair'
NODE = os.environ.get('BIMAX_TEST_NODE', shutil.which('node') or 'node')
TEST_FILES = ['app/src/__tests__/thread.persistence.sprint.test.ts']


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Mutation anchor is not unique: {old!r}')
    return text.replace(old, new, 1)


MUTANTS = [
    ('async-commit', 'app/src/main/thread.storage.ts',
     '          fs.renameSync(temporary, file);', '          await fsp.rename(temporary, file);'),
    ('accept-without-save', 'app/src/main/thread.manager.ts',
     'if (!this.persist(r, true)) { this.blockForStorage(r); return; }',
     'if ((this.persist(r, true), false)) { this.blockForStorage(r); return; }'),
    ('dispatch-after-failed-save', 'app/src/main/thread.manager.ts',
     '    if (!this.persist(r, true)) {\n      next.state',
     '    if ((this.persist(r, true), false)) {\n      next.state'),
    ('steer-after-failed-save', 'app/src/main/thread.manager.ts',
     '    if (!this.persist(r, true)) {\n      input.state',
     '    if ((this.persist(r, true), false)) {\n      input.state'),
    ('automatic-retry-without-user', 'app/src/main/thread.manager.ts',
     '|| r.holdInputs || r.storageBlocked || r.draining) return;',
     '|| r.holdInputs || r.draining) return;'),
    ('double-remote-submit', 'app/src/main/responder/adapter.ts',
     "this.threads.create(this.defaultWorkspaceDir!, '', 'project')",
     "this.threads.create(this.defaultWorkspaceDir!, input.instruction, 'project')"),
]

if '--history' in sys.argv:
    OUT = ROOT / 'docs/product-reset/evidence/2026-10-31-history-recovery'
    TEST_FILES = ['app/src/__tests__/thread.history.storage.test.ts', 'app/src/__tests__/thread.history.recovery.test.tsx']
    MUTANTS = [
        ('writer-limit', 'app/src/main/thread.storage.ts',
         "    if (Buffer.byteLength(text, 'utf8') > THREAD_SNAPSHOT_MAX_BYTES) throw new Error(HISTORY_LIMIT_MESSAGE);", ''),
        ('silent-discovery', 'app/src/main/thread.storage.ts',
         '} catch { this.reportRecovery(file, id, false); }', '} catch { /* fault: silently omit */ }'),
        ('tombstone-before-admission', 'app/src/main/thread.storage.ts',
         '    const text = this.text(this.copy(value));',
         '    const text = (this.written.set(id, Number.MAX_SAFE_INTEGER), this.text(this.copy(value)));'),
        ('unbounded-unarchive', 'app/src/main/thread.storage.ts',
         '    const value = await readThreadSnapshotAsync(source, id);', "    const value = JSON.parse(await fsp.readFile(source, 'utf8'));"),
        ('bin-envelope-limit', 'app/src/main/thread.storage.ts',
         'THREAD_SNAPSHOT_MAX_BYTES + Buffer.byteLength(JSON.stringify({ value: null, archived: false, at: Number.MAX_SAFE_INTEGER })) - 4',
         'THREAD_SNAPSHOT_MAX_BYTES'),
        ('delete-unreadable-backup', 'app/src/main/thread.bin.recovery.ts',
         'catch { this.unreadable?.(id); return []; }',
         'catch { fs.rmSync(this.backup(id), { force: true }); return []; }'),
        ('skip-source-identity', 'app/src/main/thread.recovery.export.ts',
         'if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||\n        current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink())', 'if (false)'),
        ('skip-byte-verification', 'app/src/main/thread.recovery.export.ts',
         "if (copy.digest('hex') !== digest.digest('hex'))", 'if (false)'),
        ('overwrite-recovery', 'app/src/main/thread.storage.ts',
         "    if (this.recovery.has(this.recoveryKey(value.summary.id, false))) throw new Error('Export the recovery copy before replacing this unreadable saved conversation.');", ''),
    ]


if '--out-dir' in sys.argv:
    OUT = Path(sys.argv[sys.argv.index('--out-dir') + 1]).resolve()


def main():
    version = subprocess.check_output([NODE, '--version'], text=True).strip()
    if not version.startswith('v24.'):
        raise SystemExit('Use Node 24 on PATH, or set BIMAX_TEST_NODE to its executable.')
    OUT.mkdir(parents=True, exist_ok=True)
    reports = []
    with tempfile.TemporaryDirectory(prefix='bimax-persistence-mutants-') as scratch:
        # Jest canonicalizes /var to /private/var on macOS; its explicit test path must agree.
        target = Path(scratch).resolve()
        for name in ['src', 'app/src']:
            shutil.copytree(ROOT / name, target / name)
        for name in ['package.json', 'tsconfig.json', 'jest.config.ts', 'jest.setup.ts']:
            shutil.copy2(ROOT / name, target / name)
        (target / 'scripts').mkdir()
        for name in ['jest-renderer-setup.cjs', 'jest-style.cjs']:
            shutil.copy2(ROOT / 'scripts' / name, target / 'scripts' / name)
        (target / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        (target / 'app/node_modules').symlink_to(ROOT / 'app/node_modules', target_is_directory=True)
        files = {name: (target / name).read_text() for _, name, _, _ in MUTANTS}
        for label, name, old, new in MUTANTS:
            for file, contents in files.items():
                (target / file).write_text(contents)
            (target / name).write_text(replace_once(files[name], old, new))
            result_file = OUT / f'mutant-{label}.json'
            args = [NODE, str(ROOT / 'node_modules/jest/bin/jest.js'), '--config', str(target / 'jest.config.ts'),
                    '--runInBand', '--coverage=false', '--runTestsByPath', *[str(target / test) for test in TEST_FILES],
                    '--json', '--outputFile', str(result_file)]
            with (OUT / f'mutant-{label}.log').open('w') as log:
                run = subprocess.run(args, cwd=target, stdout=log, stderr=subprocess.STDOUT, timeout=90)
            result = json.loads(result_file.read_text())
            failed = [case['fullName'] for suite in result['testResults'] for case in suite['assertionResults'] if case['status'] == 'failed']
            killed = run.returncode == 1 and bool(failed) and result.get('numRuntimeErrorTestSuites', 0) == 0
            report = dict(mutant=label, assertion_caught=killed, failed_tests=failed, exit_code=run.returncode)
            reports.append(report)
            print(json.dumps(report), flush=True)
    (OUT / 'mutations.json').write_text(json.dumps(reports, indent=2) + '\n')
    if not all(r['assertion_caught'] for r in reports):
        raise SystemExit('A mutant survived or failed for an invalid reason')


if __name__ == '__main__':
    main()
