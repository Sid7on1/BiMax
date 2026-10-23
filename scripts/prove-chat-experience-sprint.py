#!/usr/bin/env python3
"""Deliberate chat lifecycle/rendering faults must fail observed end-state assertions."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/product-reset/evidence/2026-10-06-chat-experience-sprint'
BASE = 'app/src/renderer/src/'
REQUESTS = BASE + 'engine.requests.ts'
HOOK = BASE + 'useEngine.ts'
STATE = BASE + 'engine.state.ts'
QUICK = BASE + 'quick.bootstrap.ts'
MARKDOWN = BASE + 'markdown.tsx'
LIFECYCLE = 'app/src/__tests__/chat.lifecycle.sprint.test.ts'
BOOTSTRAP = 'app/src/__tests__/quick.bootstrap.sprint.test.ts'
TESTS = [LIFECYCLE, BOOTSTRAP, 'app/src/__tests__/engine.thread.isolation.test.ts',
         'app/src/__tests__/engine.store.test.ts', 'app/src/__tests__/stream.coalescer.test.ts']
MUTANTS = [
 ('settled-request-timer', REQUESTS, 'clearTimeout(timer);', '// timer retained', LIFECYCLE, 'answered config'),
 ('request-result', REQUESTS, 'finish(value);', "finish(this.failure('wrong result'));", LIFECYCLE, 'answered config'),
 ('request-deadline', REQUESTS, ')), timeoutMs);', ')), timeoutMs + 1000);', LIFECYCLE, 'a deadline resolves once'),
 ('bridge-failure-cause', REQUESTS, 'error instanceof Error ? error.message : String(error)', "'unknown failure'", LIFECYCLE, 'synchronous bridge failure'),
 ('config-retirement', HOOK, 'configPending.current.cancelAll(reason);', '// config kept', LIFECYCLE, 'Thread changed settles'),
 ('catalog-retirement', HOOK, 'catalogPending.current.cancelAll(reason);', '// catalogue kept', LIFECYCLE, 'Thread changed settles'),
 ('attachment-retirement', HOOK, 'attachmentPending.current.cancelAll(reason);', '// attachment kept', LIFECYCLE, 'Thread changed settles'),
 ('project-retirement', HOOK, "cancelRequests('Project changed');", '// project requests kept', LIFECYCLE, 'Project changed settles'),
 ('thread-retirement', HOOK, "cancelRequests('Thread changed');", '// old chat requests kept', LIFECYCLE, 'Thread changed settles'),
 ('engine-retirement', HOOK, "if (['failed', 'exited', 'stopping', 'restarting'].includes(s)) cancelRequests(`Engine ${s}`);", '// dead engine requests kept', LIFECYCLE, 'Engine exited settles'),
 ('unmount-retirement', HOOK, "cancelRequests('Renderer closed');", '// unmounted requests kept', LIFECYCLE, 'Renderer closed settles'),
 ('attachment-routing', HOOK, 'if (attachmentPending.current.resolve(msg.id, {', 'if (attachmentPending.current.resolve(msg.id + 10000, {', LIFECYCLE, 'attachment requests share'),
 ('owner-before-response', HOOK, 'if (threadId !== store.getState().threadId) return;', '// owner check removed', LIFECYCLE, 'old Thread replies', 0),
 ('approval-thread', STATE, 'if (action.threadId !== undefined && action.threadId !== state.threadId) return state;', '// wrong chat may close', LIFECYCLE, 'a Thread boundary remains'),
 ('approval-card-id', STATE, 'if (action.id !== undefined && action.id !== state.request?.id) return state;', '// new card may close', LIFECYCLE, 'a new card id remains'),
 ('approval-token', STATE, "if (action.approvalToken !== undefined && action.approvalToken !== (state.request as (RequestMsg & { approvalToken?: string }) | null)?.approvalToken) return state;", '// reused id may close', LIFECYCLE, 'an approval id reused'),
 ('approval-read-failure', HOOK, '.approvals().catch(() => null)', '.approvals().catch(() => [])', LIFECYCLE, 'failed approval inventory'),
 ('context-broadcast-floor', QUICK, 'contextChanged = true;', '/* context floor omitted */', BOOTSTRAP, 'late Finder'),
 ('selection-broadcast-floor', QUICK, 'threadChanged = true;', '/* selection floor omitted */', BOOTSTRAP, 'late startup snapshot'),
 ('bootstrap-retirement', QUICK, 'live = false;', '/* disposed surface remains live */', BOOTSTRAP, 'closing the surface'),
 ('context-unsubscribe', QUICK, 'offContext(); offThread();', 'offThread();', BOOTSTRAP, 'initial snapshot remains'),
 ('retired-context-error', QUICK, 'if (live && !contextChanged) handlers.error', 'handlers.error', BOOTSTRAP, 'retired startup failures'),
 ('retired-chat-error', QUICK, 'if (live && !threadChanged) handlers.error', 'handlers.error', BOOTSTRAP, 'retired startup failures'),
 ('markdown-reparse', MARKDOWN, '}, [text]);', '});', 'browser', None),
 ('markdown-stale-text', MARKDOWN, '}, [text]);', '}, []);', 'browser', None),
 ('code-rehighlight', MARKDOWN, '}, [code, lang]);', '});', 'browser', None),
 ('code-stale-text', MARKDOWN, '}, [code, lang]);', '}, [lang]);', 'browser', None),
 ('code-stale-language', MARKDOWN, '}, [code, lang]);', '}, [code]);', 'browser', None),
]

def run(label, test=None, pattern=None):
 if test == 'browser':
  receipt = EVIDENCE / f'mutation-{label}.json'
  command = ['node', 'app/scripts/ui/chat-experience-sprint.mjs', f'--json={receipt}']
 else:
  command = [str(ROOT / 'node_modules/.bin/jest'), '--coverage=false', '--runInBand'] + ([test] if test else TESTS)
  if pattern: command += ['--testNamePattern', pattern]
 result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
 output = result.stdout + result.stderr
 (EVIDENCE / f'mutation-{label}.log').write_text(output)
 if test == 'browser':
  report = json.loads(receipt.read_text())
  invalid = report['invalid'] is not None
  assertion = bool(report['problems'])
 else:
  invalid = 'Test suite failed to run' in output or 'Exceeded timeout' in output
  assertion = bool(re.search(r'expect\([^\n]*\)\.', output))
 return result.returncode, assertion, invalid

if run('baseline-before')[0] or run('browser-before', 'browser')[0]: sys.exit('Initial baseline failed')
receipts = []
for label, source, old, new, test, pattern, *occurrence in MUTANTS:
 file = ROOT / source; original = file.read_bytes(); digest = hashlib.sha256(original).hexdigest()
 text = original.decode(); count = text.count(old); index = occurrence[0] if occurrence else 0
 if (not occurrence and count != 1) or count <= index: sys.exit(f'Anchor mismatch: {label}: {count}')
 offset = [m.start() for m in re.finditer(re.escape(old), text)][index]
 try:
  file.write_text(text[:offset] + new + text[offset + len(old):])
  code, assertion, invalid = run(label, test, pattern)
  killed = code != 0 and assertion and not invalid
 finally:
  file.write_bytes(original)
  restored = hashlib.sha256(file.read_bytes()).hexdigest() == digest
 receipts.append(dict(name=label, source=source, exit=code, assertion_failure=assertion,
                      invalid=invalid, killed=killed, restored=restored, sha256=digest))
 (EVIDENCE / 'mutations.json').write_text(json.dumps(receipts, indent=2) + '\n')
 print(f'{label}: {"caught" if killed else "INVALID/SURVIVED"}; restored={restored}', flush=True)
 if not restored or not killed: sys.exit(1)
if run('baseline-after')[0] or run('browser-after', 'browser')[0]: sys.exit('Restored baseline failed')
print(f'{len(receipts)} faults caught; source restored; both baselines pass.')
