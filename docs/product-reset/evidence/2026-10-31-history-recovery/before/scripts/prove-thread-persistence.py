"""Reintroduce persistence defects only in disposable source copies; require assertion failures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/product-reset/evidence/2026-10-31-persistence-repair'
NODE = os.environ.get('BIMAX_TEST_NODE', shutil.which('node') or 'node')


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
                    '--runInBand', '--coverage=false', '--runTestsByPath',
                    str(target / 'app/src/__tests__/thread.persistence.sprint.test.ts'),
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
