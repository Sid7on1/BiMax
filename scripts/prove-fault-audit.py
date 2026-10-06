#!/usr/bin/env python3
"""Controlled fault-audit mutants. Run alone; restore exact dirty source bytes in finally."""
import hashlib
import json
import signal
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/product-reset/evidence/2026-10-04-fault-audit/mutations'
AUDIT = 'src/__tests__/fault.audit.regression.test.ts'
PROVIDER = 'src/__tests__/fault.audit.provider.test.ts'
SENSOR = 'src/mind/__tests__/outcome.sensor.test.ts'
PROMPT = 'src/__tests__/persona.prompt.split.test.ts'
CONTEXT = 'src/__tests__/context.layers.test.ts'
CASES = [
    ('hard-loop-halt', 'src/core/agent.tool.round.ts', "loopSignals.some(signal => signal.type === 'circuit_breaker') || st.hardLoopRounds >= 3", 'false', AUDIT, 'halts a model'),
    ('verified-transition', 'src/outcome/outcome.manager.ts', "if (status === 'verified') return this.validateTask(id);", '// validation bypassed', AUDIT, 'refuses direct verified'),
    ('criterion-scope', 'src/outcome/outcome.manager.ts', "event.repoWide === true || (c.files?.length", "event.repoWide !== null || (c.files?.length", AUDIT, 'refuses direct verified|unscoped build'),
    ('scoped-execution-proof', 'src/mind/outcome.sensor.ts', '...(!wholeProject ? { exactFiles } : {})', '...({})', SENSOR, 'scoped green tests|sibling or subfolder'),
    ('trace-redaction', 'src/telemetry/trace.ts', 'span = redactSecretsDeep(span);', '// scrub bypassed', AUDIT, 'redacts modern keys'),
    ('file-provenance', 'src/mind/taint.ts', "'ToolWorkflowTool'].includes(toolName)) return 'file';", "'ToolWorkflowTool'].includes(toolName)) return null;", AUDIT, 'fences repository text|labels and taints'),
    ('shell-read-provenance', 'src/mind/taint.ts', "if (toolName === 'BashTool') return 'shell';", "if (toolName === 'BashTool') return null;", AUDIT, 'poisoned file read through Bash'),
    ('same-round-taint', 'src/core/tool.outcome.observers.ts', 'markToolTaint(call.name, args, result);', '// defer safety marking until after the batch', AUDIT, 'poisoned file read through Bash'),
    ('taint-bypass', 'src/governor/governor.ts', "this.mode === 'bypass' && !taintCut", "this.mode === 'bypass'", AUDIT, 'fences repository text'),
    ('exact-shell-grant', 'src/governor/governor.ts', 'r.pattern !== undefined && r.pattern === payload.command', 'true', AUDIT, 'shell allow remembers'),
    ('approval-reader', 'src/tools/shell.readonly.ts', 'if (!isReadOnlyShellCommand(command)) return false;\n  return splitPipeline', 'return isReadOnlyShellCommand(command);\n  return splitPipeline', AUDIT, 'concurrency reader'),
    ('background-containment', 'src/core/shell.tasks.ts', 'const argv = floorArgv(command) ?? sandboxArgv(command, cwd);', 'const argv: string[] | null = null;', AUDIT, 'background Thread shell'),
    ('run-ceiling', 'src/core/run.budget.ts', 'if (old + value > Atomics.load(counters, slot + 2))', 'if (false && old + value > Atomics.load(counters, slot + 2))', AUDIT, 'run ceilings share'),
    ('adapter-admission', 'src/core/llm.adapter.ts', 'reserveRun(inputTokens + outputTokens, estimatedCostUsd)', 'reserveRun(0, 0)', PROVIDER, 'denies the actual adapter'),
    ('worker-budget-sharing', 'src/core/subagent.manager.ts', 'config.runBudget = activeRunBudget();', 'config.runBudget = undefined;', PROVIDER, 'same run counters'),
    ('split-pricing', 'src/core/model.pricing.ts', "output: 1.2, cachedInput: 0.006", "output: 2, cachedInput: 0.3", PROVIDER, 'settles split usage'),
    ('memory-cache', 'src/memory/vector.store.ts', 'if (identity === this.diskIdentity) return;', '// always reload', AUDIT, 'unchanged memory queries'),
    ('memory-invalidation', 'src/memory/vector.store.ts', 'if (identity === this.diskIdentity) return;', 'if (this.diskIdentity !== null) return;', AUDIT, 'unchanged memory queries'),
    ('identifier-components', 'src/memory/bm25.ts', "split === word ? [word] : [word, ...split.split(' ')]", '[word]', AUDIT, 'camelCase search'),
    ('prompt-bound', 'src/engine/personas/base.persona.ts', 'let optionalChars = 12_000;', 'let optionalChars = 1_000_000;', PROMPT, 'bounds optional recall'),
    ('save-cache-identity', 'src/memory/vector.store.ts', 'this.diskIdentity = stillOurs ?', 'this.diskIdentity = true ?', AUDIT, 'external writer identity'),
    ('generator-error-propagation', 'src/core/agent.loop.ts', 'throw: (error: unknown) => inRunBudget(buffer, () => iterator.throw(error)),', '// injected errors lose their forwarding path', PROVIDER, 'injected-error cleanup'),
    ('repomap-opt-out', 'src/memory/context.manager.ts', "if (process.env.BIMAX_REPO_MAP === '0') msgs = injectRepoMap(msgs, '');", '// ignore opt-out', CONTEXT, 'RepoMap opt-out'),
]


def run(label, suites, pattern=None):
    result = OUT / (label + '.json')
    command = ['npx', 'jest', '--coverage=false', '--runInBand', '--json', '--outputFile=' + str(result), *suites]
    if pattern:
        command += ['--testNamePattern=' + pattern]
    with (OUT / (label + '.log')).open('w') as log:
        completed = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=120)
    report = json.loads(result.read_text())
    failures = [test['fullName'] for suite in report['testResults'] for test in suite['assertionResults'] if test['status'] == 'failed']
    return completed.returncode, failures, report['numPassedTests']


def interrupted(signum, frame):
    raise KeyboardInterrupt('Mutation run interrupted; restoring current source.')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, interrupted)
    code, failures, passed = run('baseline', [AUDIT, PROVIDER, SENSOR, PROMPT, CONTEXT])
    if code or failures:
        raise SystemExit('Baseline failed; no mutations applied.')
    print(f'baseline passed: {passed} tests', flush=True)
    receipts = []
    for label, relative, old, new, suite, pattern in CASES:
        file = ROOT / relative
        original = file.read_bytes()
        source = original.decode()
        if old not in source:
            raise SystemExit('Missing mutation anchor: ' + label)
        mutated = source.replace(old, new, 1).encode()
        # Match both adapter reservation sites, not just the nonstreaming helper.
        if label == 'adapter-admission':
            mutated = source.replace(old, new).encode()
        # Per-block and shared budgets are both required to exceed the test's boundary.
        if label == 'prompt-bound':
            mutated = mutated.replace(b'Math.min(text.length, 2_000, optionalChars)', b'Math.min(text.length, 200_000, optionalChars)')
        try:
            file.write_bytes(mutated)
            code, failures, passed = run(label, [suite], pattern)
        finally:
            file.write_bytes(original)
        restored = hashlib.sha256(file.read_bytes()).hexdigest() == hashlib.sha256(original).hexdigest()
        killed = code != 0 and len(failures) > 0  # compiler/import/process errors alone never count
        receipts.append(dict(label=label, file=relative, killed=killed, restored=restored, failedAssertions=failures,
            sourceSha256=hashlib.sha256(original).hexdigest(), exitCode=code))
        (OUT / 'receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
        print(label + ': ' + ('caught by assertions' if killed else 'SURVIVED/INVALID') + f'; restored={restored}', flush=True)
        if not killed or not restored:
            raise SystemExit('Mutation campaign incomplete: ' + label)
    code, failures, passed = run('restored-baseline', [AUDIT, PROVIDER, SENSOR, PROMPT, CONTEXT])
    if code or failures:
        raise SystemExit('Restored baseline failed.')
    print(f'complete: {len(receipts)} mutants caught, exact source restored, {passed} baseline tests pass', flush=True)


if __name__ == '__main__':
    main()
