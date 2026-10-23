#!/usr/bin/env python3
"""Executable transaction regressions; each mutant must fail assertions, then restore bytes."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/product-reset/evidence/2026-10-06-transaction-sprint"
EVIDENCE.mkdir(parents=True, exist_ok=True)
SOURCE = "src/core/transaction.manager.ts"
COMMAND = "src/engine/commands/tx.ts"
TEST = "src/__tests__/transaction.sprint.test.ts"
COMMAND_TEST = "src/__tests__/transaction.command.sprint.test.ts"

MUTANTS = [
    ("single-snapshot", SOURCE, "let snapshot = tx.snapshots.get(key);",
     "let snapshot: Promise<EditRecord> | undefined;", TEST, "coalesces concurrent"),
    ("commit-capture-fence", SOURCE, "if (this.openTx.pending) return 'Snapshot capture",
     "if (this.openTx.pending < 0) return 'Snapshot capture", TEST, "refuses commit"),
    ("rollback-capture-fence", SOURCE, "if (this.openTx.pending) {", "if (this.openTx.pending < 0) {",
     TEST, "refuses rollback"),
    ("automatic-rollback-truth", SOURCE, "const outcome = result.id === txId", "const outcome = true",
     TEST, "never claims automatic rollback"),
    ("begin-restoration-fence", SOURCE, "if (this.rollingBack) return 'A restoration is in progress.",
     "if (false && this.rollingBack) return 'A restoration is in progress.", TEST, "blocks a new transaction"),
    ("tracking-restoration-fence", SOURCE, "if (this.rollingBack) throw new Error('A restoration",
     "if (false && this.rollingBack) throw new Error('A restoration", TEST, "blocks a new transaction"),
    ("prior-recovery-retention", SOURCE, "const dir = keep.length ? await this.retainBaselines(id, keep, entries) : null;",
     "const dir = keep.length ? await this.retainBaselines(id, keep, entries) : null; this.retained.clear();",
     TEST, "keeps previous recovery"),
    ("recovery-open-fence", SOURCE, "if (this.openTx) return 'Commit or roll back the open transaction",
     "if (false && this.openTx) return 'Commit or roll back the open transaction", TEST, "refuses recovery inside"),
    ("recovery-single-flight", SOURCE, "if (this.rollingBack) return 'A restoration is already in progress.';",
     "if (false && this.rollingBack) return 'A restoration is already in progress.';", TEST, "serializes recovery callers"),
    ("mode-only-conflict", SOURCE, "if (currentToken === baselineToken && modeMatches) {",
     "if (currentToken === baselineToken) {", TEST, "mode-only external"),
    ("permission-readback", SOURCE, "after.sha256 !== baseline.sha256 || after.mode !== baseline.mode",
     "after.sha256 !== baseline.sha256", TEST, "read-back finds wrong permissions"),
    ("forced-end-state", SOURCE, "const current = await this.capture(absPath);",
     "const current = await this.capture(absPath); if (force && current.kind === 'unreadable') return { absPath, status: 'restored', verified };",
     TEST, "verifies forced rollback"),
    ("aggregate-reservation", SOURCE, "if (reserveBaseline && st.size > this.maxTotalSnapshotBytes - this.heldSnapshotBytes)",
     "if (false && reserveBaseline && st.size > this.maxTotalSnapshotBytes - this.heldSnapshotBytes)",
     TEST, "reserves aggregate memory"),
    ("retained-byte-accounting", SOURCE, "this.releaseBaselines(this.openTx.edits);",
     "this.heldSnapshotBytes = 0;", TEST, "counts retained recovery bytes"),
    ("stable-read-check", SOURCE,
     "if (offset !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs ||\n          after.ctimeMs !== st.ctimeMs || after.mode !== st.mode || atPath.dev !== st.dev || atPath.ino !== st.ino)",
     "if (false)", TEST, "rejects a growing file|rejects a path replaced"),
    ("dangling-link-baseline", SOURCE, "e?.code === 'ENOENT' && !handle && !viaSymlink",
     "e?.code === 'ENOENT' && !handle", TEST, "dangling symlink"),
    ("short-read-loop", SOURCE, "while (offset < bytes.length)", "while (offset === 0 && offset < bytes.length)",
     TEST, "fills short reads"),
    ("symlink-chmod-truth", SOURCE, "await fs.chmod(absPath, baseline.mode);",
     "await fs.chmod(absPath, baseline.mode).catch(() => {});", TEST, "symlink chmod failure"),
    ("begin-command-truth", COMMAND, "globalTransactionManager.currentId() === id ? 'success' : 'error'",
     "'success'", COMMAND_TEST, "during restoration"),
    ("commit-command-truth", COMMAND, "wasOpen && !globalTransactionManager.isOpen() ? 'success' : 'error'",
     "'success'", COMMAND_TEST, "pending snapshot refusals"),
    ("status-all-recoveries", COMMAND, "const pending = globalTransactionManager.pendingRecoveries();",
     "const pending = globalTransactionManager.pendingRecoveries().slice(0, 1);", COMMAND_TEST, "all retained transactions"),
]


def run(label, test=None, pattern=None):
    command = [str(ROOT / "node_modules/.bin/jest"), "--coverage=false", "--runInBand"]
    command.extend([test] if test else [TEST, COMMAND_TEST, "src/__tests__/transaction.rollback.test.ts"])
    if pattern:
        command.extend(["--testNamePattern", pattern])
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    (EVIDENCE / f"mutation-{label}.log").write_text(output)
    return result.returncode, output


if run("baseline-before")[0] != 0:
    sys.exit("Pre-mutation baseline failed; see evidence")
receipts = []
for label, source, old, new, test, pattern in MUTANTS:
    file = ROOT / source
    original = file.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if original.decode().count(old) != 1:
        sys.exit(f"Mutation anchor is not unique: {label}")
    try:
        file.write_bytes(original.decode().replace(old, new, 1).encode())
        code, output = run(label, test, pattern)
        assertion_failure = bool(re.search(r"expect\([^\n]*\)\.", output))
        invalid = "Test suite failed to run" in output or "Exceeded timeout" in output
        killed = code != 0 and assertion_failure and not invalid
    finally:
        file.write_bytes(original)
        restored = hashlib.sha256(file.read_bytes()).hexdigest() == digest
    receipts.append(dict(name=label, source=source, exit=code, assertion_failure=assertion_failure,
                         invalid=invalid, killed=killed, restored=restored, sha256=digest))
    print(f"{label}: {'caught' if killed else 'INVALID/SURVIVED'}, restored={restored}", flush=True)
    (EVIDENCE / "mutations.json").write_text(json.dumps(receipts, indent=2) + "\n")
    if not restored or not killed:
        sys.exit(1)
if run("baseline-after")[0] != 0:
    sys.exit("Restored baseline failed")
print(f"All {len(receipts)} mutants caught; source bytes restored; before/after baselines passed.")
