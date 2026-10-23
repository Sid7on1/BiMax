#!/usr/bin/env python3
"""Behavioral mutations of the background task sprint; restore exact dirty source bytes."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/product-reset/evidence/2026-10-06-background-task-sprint"
EVIDENCE.mkdir(parents=True, exist_ok=True)
SHELL = "src/core/shell.tasks.ts"
REGISTRY = "src/core/task.registry.ts"
TASKS = "src/tools/implementations/tasks.tool.ts"
BASH = "src/tools/implementations/bash.tool.ts"
TAINT = "src/mind/taint.ts"
SHELL_TEST = "src/__tests__/shell.tasks.sprint.test.ts"
TASKS_TEST = "src/__tests__/tasks.shell.tool.test.ts"

MUTANTS = [
    ("paused-cancel-wake", SHELL, "signalGroup('SIGCONT');", "/* wake removed */", SHELL_TEST, "cancel wakes"),
    ("termination-escalation", SHELL, "() => signalGroup('SIGKILL')", "() => signalGroup('SIGTERM')", SHELL_TEST, "escalates"),
    ("paused-close-reconciliation", REGISTRY,
     "'paused':           ['running', 'cancelling', 'cancelled', 'completed', 'failed', 'failed-resumable']",
     "'paused':           ['running', 'cancelling', 'cancelled']", SHELL_TEST, "close racing pause"),
    ("utf8-pipe-decoder", SHELL, "decoders.stdout.write(d)", "d.toString()", SHELL_TEST, "preserves UTF-8"),
    ("pipe-chunks-as-lines", SHELL, "registry.appendStreamOutput(task.id, text, channel);",
     "registry.appendOutput(task.id, text);", SHELL_TEST, "preserves UTF-8|no-newline"),
    ("shell-discovery", TASKS, "const shells = registry.list().filter(t => t.kind === 'shell');",
     "const shells: WorkspaceTask[] = [];", TASKS_TEST, "lists and inspects"),
    ("wait-exact-target", TASKS,
     "const workers = args.taskId ? worker ? [worker] : [] : bb.active();",
     "const workers = bb.active();", TASKS_TEST, "targeted wait ignores"),
    ("wait-abort", TASKS, "timeoutMs, context?.signal);", "timeoutMs, undefined);", TASKS_TEST, "Stop interrupts"),
    ("wait-subscription-cleanup", TASKS, "for (const dispose of disposers) dispose();",
     "/* subscriptions leaked */", TASKS_TEST, "deadline expiry disposes"),
    ("mutating-task-concurrency", TASKS,
     "isConcurrencySafe: (args: any) => ['list', 'get', 'wait'].includes(String(args?.action || '').toLowerCase()),",
     "isConcurrencySafe: true,", TASKS_TEST, "only read actions"),
    ("explicit-background-timeout", BASH,
     "timeoutMs: args.timeout === undefined ? 0 : timeoutMs,",
     "timeoutMs: timeoutMs > 30_000 ? timeoutMs : 0,", SHELL_TEST, "explicit short background timeout"),
    ("failed-background-start-truth", BASH,
     "if (task.state === 'failed-resumable') throw classifiedError(summary, 'external');",
     "/* false success restored */", SHELL_TEST, "synchronously failed spawn"),
    ("task-output-provenance", TAINT,
     "if (toolName === 'BashTool' || toolName === 'TasksTool') return 'shell';",
     "if (toolName === 'BashTool') return 'shell';", TASKS_TEST, "shell provenance"),
]

def run(label, test, pattern=None):
    command = [str(ROOT / "node_modules/.bin/jest"), "--coverage=false", "--runInBand", test]
    if pattern:
        command.extend(["--testNamePattern", pattern])
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    (EVIDENCE / f"mutation-{label}.log").write_text(output)
    return result.returncode, output

code, _ = run("baseline-before", "src/__tests__/shell.tasks")
# Explicitly include both groups, avoiding dependence on Jest's path matching convention.
if code != 0:
    sys.exit("Pre-mutation shell baseline failed; see evidence")
code, _ = run("tool-baseline-before", TASKS_TEST)
if code != 0:
    sys.exit("Pre-mutation tool baseline failed; see evidence")

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
    receipt = dict(name=label, source=source, exit=code, assertion_failure=assertion_failure,
                   invalid=invalid, killed=killed, restored=restored, sha256=digest)
    receipts.append(receipt)
    print(f"{label}: {'caught' if killed else 'INVALID/SURVIVED'}, restored={restored}", flush=True)
    (EVIDENCE / "mutations.json").write_text(json.dumps(receipts, indent=2) + "\n")
    if not restored or not killed:
        sys.exit(1)

for label, test in [("baseline-after", "src/__tests__/shell.tasks"), ("tool-baseline-after", TASKS_TEST)]:
    code, _ = run(label, test)
    if code != 0:
        sys.exit("Post-mutation baseline failed; see evidence")
print(f"All {len(receipts)} behavioral mutants caught with exact source restoration.")
