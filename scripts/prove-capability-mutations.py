#!/usr/bin/env python3
"""Serial, reversible behavioral mutations. Each must produce a Jest assertion failure.
Restores exact bytes even on interruption; do not edit the named files concurrently.
"""
import datetime, hashlib, json, pathlib, subprocess
repo = pathlib.Path(__file__).resolve().parents[1]
run = repo / 'docs/product-reset/evidence/capability-failures' / ('mutations-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
run.mkdir(parents=True)
cases = [
 ('memory-corruption-guard', 'src/memory/vector.store.ts', "// Never overwrite an unreadable store with the constructor's empty in-memory default.\n      await this.loadStore(true);", "// Mutation: omit read validation before writing.", 'capability.silence', 'corrupt memory storage'),
 ('mcp-result-error', 'src/mcp/client.ts', "res?.isError ? outcomeError('unknown',", "false ? outcomeError('unknown',", 'capability.silence', 'MCP startup'),
 ('cli-notice', 'src/cli/print.ts', "cliEvents.on('message', onCapability);", "// Mutation: omit live notices.", 'print.capability', 'plain CLI'),
 ('desktop-reload', 'app/src/main/capability.replay.ts', "return [...this.active.values()];", "return [];", 'app/src/__tests__/capability.replay.test.ts', 'fresh renderer'),
 ('notice-emission', 'src/core/capability.status.ts', "cliEvents.emit('message', capabilityMessage(status));", "void capabilityMessage(status);", 'capability.silence', 'HTTP 410 reaches'),
 ('wire-priority', 'src/protocol/wire.queue.ts', "? 'critical' : 'bulk'", "? 'bulk' : 'bulk'", 'capability.silence', 'pre-host failures'),
 ('renderer-delivery', 'app/src/renderer/src/engine.state.ts', "msg.role === 'system' ? msg.payload?.capabilityStatus : undefined", "msg.role === 'assistant' ? msg.payload?.capabilityStatus : undefined", 'capability.silence', 'HTTP 410 reaches'),
 ('workspace-boundary', 'src/governor/fs.veto.ts', "normalized !== canonicalWorkspace && !normalized.startsWith(withSep)", "false", 'capability.silence', 'directory boundary'),
 ('index-coverage', 'src/memory/code.index.ts', "private reportIndex(reason: string, ready = false): void {", "private reportIndex(reason: string, ready = false): void { return;", 'capability.silence', 'partial index'),
 ('document-activation', 'src/core/agent.loop.ts', "&& this.tools.getTool('DocumentTool'))", "&& false)", 'agent.loop.silence', 'model ignoring'),
 ('error-presentation', 'src/core/agent.loop.ts', "finish(resultStr, !!typed && typed.status !== 'ok', typed)", "finish(resultStr, false, typed)", 'agent.loop.silence', 'typed tool error'),
 ('mcp-notice', 'src/mcp/manager.ts', "private reportConnection(name: string, ready: boolean): void {", "private reportConnection(name: string, ready: boolean): void { return;", 'capability.silence', 'MCP startup'),
]
results = []
for name, relative, before, after, suite, pattern in cases:
    target = repo / relative
    original = target.read_bytes()
    content = original.decode()
    if content.count(before) != 1: raise RuntimeError(f'{name}: mutation anchor is not unique')
    try:
        target.write_text(content.replace(before, after))
        process = subprocess.run(['npx', 'jest', '--coverage=false', '--runInBand', suite if suite.startswith('app/') else f'src/__tests__/{suite}.test.ts', '-t', pattern], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        output = process.stdout.decode(errors='replace')
        (run / (name + '.log')).write_text(output)
        caught = process.returncode != 0 and 'Tests:' in output and 'failed' in output and ('expect(' in output or 'Expected:' in output)
        results.append(dict(name=name, source=relative, originalSha256=hashlib.sha256(original).hexdigest(), exitCode=process.returncode, status='caught' if caught else 'invalid-or-survived'))
        print(name, results[-1]['status'], flush=True)
    finally:
        target.write_bytes(original)
        assert target.read_bytes() == original
        (run / 'result.json').write_text(json.dumps(dict(cases=results, status='pass' if len(results)==len(cases) and all(r['status']=='caught' for r in results) else 'incomplete-or-fail'), indent=2))
print(run)
if not all(r['status']=='caught' for r in results): raise SystemExit(1)
