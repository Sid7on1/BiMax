#!/usr/bin/env python3
"""Inject context source faults, require assertion failures, and restore exact working-tree bytes."""
import argparse
import hashlib
import json
import os
import tempfile
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'docs/product-reset/evidence/2026-10-13-context-orchestration/mutations')
OUT = parser.parse_args().output
OUT.mkdir(parents=True, exist_ok=True)
JEST = ['node', 'node_modules/jest/bin/jest.js', '--coverage=false', '--runInBand', 'src/__tests__/context.orchestration.sprint.test.ts']
CM = 'src/memory/context.manager.ts'
HISTORY = 'src/context/history.ts'
FAULTS = [
    ('aux-work-before-refusal', 'src/core/agent.loop.ts', 'if (plan.messageBudget > 0) {', 'if (true) {', 'impossible fixed request'),
    ('missing-seed-import-relation', 'src/tools/implementations/code.search.tool.ts', "relations.add(`- ${connection.relation.slice('imported by '.length)} — imports ${connection.path}`);", '// fault: omit matched importer relation', 'results come with'),
    ('summary-missing-active-goal', CM, "...(latestHumanRequest(messages) ? [{ role: 'user' as const, content: contentToText(latestHumanRequest(messages)!.content) }] : []),", '// fault: omit active goal', 'summarizer sees the active request'),
    ('undersized-reply-reserve', 'src/context/request.budget.ts', 'Math.max(0, Math.floor(input.outputBudget))', 'Math.max(0, Math.min(Math.floor(input.outputBudget), Math.floor(window * 0.15)))', 'actual allowed reply'),
    ('stale-content-cache', CM, 'hit.text === text && hit.reasoning', 'true && hit.reasoning', 'text-part mutation'),
    ('stale-tool-cache', CM, 'if (!unchanged) {', 'if (!hit) {', 'in-place tool argument'),
    ('unbounded-summary-input', CM, "if (remaining < 0) return '[]';", 'if (remaining < 0) return JSON.stringify(messages);', 'always returns valid JSON'),
    ('summary-end-starvation', CM, 'if (takeHead) headBlocked = true; else tailBlocked = true;', 'break;', 'huge oldest'),
    ('serialize-backlog-twice', CM, 'const encoded = messages.map(m => serializeSummaryMessage(m, limitChars));', 'JSON.stringify(messages);\n  const encoded = messages.map(m => serializeSummaryMessage(m, limitChars));', 'serialized once'),
    ('lose-active-request', HISTORY, 'return request && !tail.includes(request) ? [request, ...tail] : tail;', 'return tail;', 'keeps the full active'),
    ('split-tool-exchange', HISTORY, 'start = complete ? owner : end;', 'start = end;', 'complete parallel tool'),
    ('attach-invalid-results', HISTORY, 'start = complete ? owner : end;', 'start = owner >= 0 ? owner : end;', 'result group is never'),
    ('ignore-summary-error-event', CM, "if (event.type === 'error') {", "if (event.type === 'error' && event.recoverable === false) {", 'context error event triggers'),
    ('publish-truncated-summary', CM, "if (event.type === 'truncated') throw new Error('Context summary was truncated.');", '// fault: publish truncated output', 'truncated stream'),
    ('publish-empty-summary', CM, "if (!text.trim()) throw new Error('Context summary was empty.');", "return text || 'FAKE SUCCESS';", 'empty stream'),
    ('unbounded-summary-output', CM, "if (text.length > 32_000) throw new Error('Context summary exceeded its output bound.');", '// fault: no bound', 'unbounded provider output'),
    ('overdue-summary', CM, 'withRequestDeadline(180_000, parent,', 'withRequestDeadline(180_000_000, parent,', 'whole summary deadline'),
    ('ignore-summary-stop', CM, 'withRequestDeadline(180_000, parent,', 'withRequestDeadline(180_000, undefined,', 'Stop settles a stalled'),
    ('late-compaction-commit', CM, 'if (this.compactionEpoch !== myEpoch) return messages;', '// fault: commit superseded restoration', 'superseded compaction'),
    ('early-continuation-commit', CM, 'const recentReads = fileStateCache.getRecentReads();', 'this.continuation.absorb(olderMessages, (text) => this.archive(text));\n    const recentReads = fileStateCache.getRecentReads();', 'superseded compaction'),
    ('archive-pointer-is-text', CM, 'handles.has(span.rawHandle) && span.text.length > 0 && contents.some(content => content.includes(span.text))', 'handles.has(span.rawHandle)', 'archive pointer alone'),
    ('wrong-file-range-resident', CM, '&& span.text.length > 0 && content.includes(span.text)', '', 'different range of the same file'),
    ('dependency-is-resident', CM, 'if (source && !this.evidence.isStale(source.id) && source.text.length > 0\n          && contents.some(content => content.includes(source.text)))', 'if (source)', 'unseen dependency'),
    ('abort-is-unreadable', 'src/context/evidence.ts', '  } catch {\n    signal?.throwIfAborted();\n    return null;', '  } catch {\n    return null;', 'cancelled freshness'),
    ('recall-ignores-stop', 'src/core/agent.loop.ts', 'withRequestDeadline(30_000, signal,', 'withRequestDeadline(30_000, undefined,', 'Stop during recall'),
    ('loop-drops-context-signal', 'src/core/agent.loop.ts', 'this.prepareRound(st, systemPrompt, options, contextMode, signal)', 'this.prepareRound(st, systemPrompt, options, contextMode)', 'Stop during compaction'),
]
results = []
for name, rel, before, after, test in FAULTS:
    file = ROOT / rel
    original = file.read_bytes()
    source = original.decode()
    assert source.count(before) == 1, (name, source.count(before))
    try:
        file.write_text(source.replace(before, after))
        command = ['bun', 'test', './src/__tests__/context.code.connections.test.ts', '-t', test] if name == 'missing-seed-import-relation' else JEST + ['-t', test]
        with tempfile.TemporaryDirectory(prefix='bimax-context-fault-') as state:
            env = dict(os.environ, BIMAX_STATE_DIR=state + '/state', BIMAX_BREAKGLASS_DIR=state + '/breakglass')
            run = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=35)
        log = run.stdout + run.stderr
        (OUT / f'{name}.log').write_text(log)
        assertion = 'expect(received)' in log or 'expect(jest.fn())' in log
        invalid = any(s in log for s in ['Test suite failed to run', 'Exceeded timeout', 'Cannot find module', 'FATAL ERROR'])
        result = {'fault': name, 'exit': run.returncode, 'assertion_caught': run.returncode != 0 and assertion and not invalid}
    finally:
        file.write_bytes(original)
    result.update(exact_restoration=file.read_bytes() == original, restored_sha256=hashlib.sha256(original).hexdigest())
    results.append(result)
    print(json.dumps(result), flush=True)
run = subprocess.run(JEST, cwd=ROOT, capture_output=True, text=True, timeout=40)
(OUT / 'restored-baseline.log').write_text(run.stdout + run.stderr)
(OUT / 'results.json').write_text(json.dumps({'faults': results, 'restored_exit': run.returncode}, indent=2) + '\n')
raise SystemExit(0 if run.returncode == 0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
