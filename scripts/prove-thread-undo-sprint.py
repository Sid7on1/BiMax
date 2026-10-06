#!/usr/bin/env python3
"""Catch executable undo faults with assertions and restore exact source bytes."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/product-reset/evidence/2026-10-06-thread-undo-sprint'
SOURCE = 'app/src/main/thread.undo.ts'
JOURNAL = 'src/tools/thread.journal.ts'
TEST = 'app/src/__tests__/thread.undo.sprint.test.ts'
JOURNAL_TEST = 'src/__tests__/thread.journal.sprint.test.ts'
TESTS = [TEST, JOURNAL_TEST, 'app/src/__tests__/thread.undo.test.ts', 'app/src/__tests__/thread.history.test.ts', 'app/src/__tests__/organize.plan.test.ts', 'app/src/__tests__/notch.hatchback.test.ts', 'app/src/__tests__/thread.recovery.test.ts', 'src/__tests__/thread.journal.test.ts']
MUTANTS = [
    ('canonical-journal-single-flight', SOURCE, "if (activeUndo.has(key)) throw", "if (false && activeUndo.has(key)) throw", TEST, 'serializes concurrent'),
    ('batch-single-flight', SOURCE, "return withUndoLock(stateRoot, canonicalState => undoBackToUnlocked(canonicalState, threadRoot, bin, id));", "return undoBackToUnlocked(stateRoot, threadRoot, bin, id);", TEST, 'holds the journal lock'),
    ('canonical-parent-containment', SOURCE, "if (!inside(root, resolved)) throw", "if (false && !inside(root, resolved)) throw", TEST, 'symlinked parent outside'),
    ('journal-directory-containment', SOURCE, "await assertContained(key, journalFile(key), true, 'this Bimax Thread’s state folder');", "// containment removed", TEST, 'symlinked journal directory'),
    ('saved-copy-preflight', SOURCE, "if ((await fs.lstat(op.backup)).isSymbolicLink()) throw new Error('the saved copy is a symlink');\n        proofs.set(index, await fileProof(op.backup));", "if (await exists(op.backup)) proofs.set(index, await fileProof(op.backup));", TEST, 'preflights every saved copy'),
    ('saved-copy-leaf-link', SOURCE, "if ((await fs.lstat(op.backup)).isSymbolicLink()) throw", "if ((await fs.lstat(op.backup)).isSymbolicLink() && false) throw", TEST, 'rejects backup leaf links'),
    ('created-item-postcondition', SOURCE, "if (await exists(op.path)) throw new Error('Undo failed: the created item is still present after the Bin operation.');", "// created-item check removed", TEST, 'Bin callback leaves'),
    ('staged-copy-postcondition', SOURCE, "await verifyFile(staged, expected);", "// staged verification removed", TEST, 'corrupted staged copy'),
    ('restored-byte-postcondition', SOURCE, "actual.sha256 !== expected.sha256 || ", "", TEST, 'corrupted final bytes'),
    ('restored-mode-postcondition', SOURCE, "actual.mode !== expected.mode || ", "", TEST, 'incorrect final permissions'),
    ('bin-source-postcondition', SOURCE, "if (await exists(op.trashPath!)) throw new Error('Undo failed: the original item is still in the Bin.');", "// Bin source check removed", TEST, 'copied Bin file'),
    ('move-postcondition', SOURCE, "if (await exists(op.to) || before.dev !== after.dev || before.ino !== after.ino) throw", "if (false) throw", TEST, 'rename callback that only copies'),
    ('verified-step-receipt', SOURCE, "await fs.appendFile(journalFile(stateRoot), JSON.stringify({ type: 'undo-step', id: change.id, index, at: Date.now() }) + '\\n', 'utf8');", "// verified-step receipt removed", TEST, 'resumes only unfinished'),
    ('journal-operation-validation', SOURCE, " || !record.ops.every(validOp)", "", TEST, 'malformed operation kinds'),
    ('backup-stability', SOURCE, "if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||\n        after.mode !== before.mode || atPath.dev !== before.dev || atPath.ino !== before.ino) throw", "if (false) throw", TEST, 'changing backup during preflight'),
    ('history-backup-coverage', SOURCE, "!usableBackup(stateRoot, op.backup)", "false", TEST, 'missing backup coverage'),
    ('private-journal-mutation', SOURCE, "if (resolved === undoDir || inside(undoDir, resolved) || inside(resolved, undoDir)) throw", "if (false) throw", TEST, 'journal self-mutation'),
    ('backup-failure-coverage', JOURNAL, "ops.push({ op: 'unprotected', path: target, reason: (error as Error).message });", "// backup coverage omitted", JOURNAL_TEST, 'silently omitting'),
    ('symlink-replacement-coverage', JOURNAL, "if ((await fs.lstat(target)).isSymbolicLink()) throw", "if (false && (await fs.lstat(target)).isSymbolicLink()) throw", JOURNAL_TEST, 'symlink and directory'),
]

def run(label, test=None, pattern=None):
    command = [str(ROOT / 'node_modules/.bin/jest'), '--coverage=false', '--runInBand'] + ([test] if test else TESTS)
    if pattern: command += ['--testNamePattern', pattern]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    (EVIDENCE / f'mutation-{label}.log').write_text(output)
    return result.returncode, output

if run('baseline-before')[0]: sys.exit('Pre-mutation baseline failed')
receipts = []
for label, source, old, new, test, pattern in MUTANTS:
    file = ROOT / source
    original = file.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if original.decode().count(old) != 1: sys.exit(f'Anchor is not unique: {label}')
    try:
        file.write_bytes(original.decode().replace(old, new, 1).encode())
        code, output = run(label, test, pattern)
        assertion_failure = bool(re.search(r'expect\([^\n]*\)\.', output))
        invalid = 'Test suite failed to run' in output or 'Exceeded timeout' in output
        killed = code != 0 and assertion_failure and not invalid
    finally:
        file.write_bytes(original)
        restored = hashlib.sha256(file.read_bytes()).hexdigest() == digest
    receipts.append(dict(name=label, source=source, exit=code, assertion_failure=assertion_failure, invalid=invalid, killed=killed, restored=restored, sha256=digest))
    (EVIDENCE / 'mutations.json').write_text(json.dumps(receipts, indent=2) + '\n')
    print(f'{label}: {"caught" if killed else "INVALID/SURVIVED"}, restored={restored}', flush=True)
    if not restored or not killed: sys.exit(1)
if run('baseline-after')[0]: sys.exit('Restored baseline failed')
print(f'All {len(receipts)} mutants caught; source restored; before/after baselines passed.')
