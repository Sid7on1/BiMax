/** Fresh real AgentLoop -> background Bash -> drained process output -> durable claim proof. */
import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import type { ChatEvent, LLMProvider } from '../core/llm.provider';

const MODES = ['named', 'no-files', 'cancel', 'changed', 'green', 'green-unexecuted', 'green-repo-wide', 'green-partial', 'green-no-coverage'];

async function main() {
  if (!process.argv[2]) throw new Error(`Usage: bun src/mind/background.proof.ts <new-directory> [${MODES.join('|')}]`);
  const destination = path.resolve(process.argv[2]);
  const mode = process.argv[3] ?? 'named';
  assert.ok(MODES.includes(mode));
  const isGreen = mode.startsWith('green');
  fs.mkdirSync(destination);
  const root = path.join(destination, 'workspace'); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root]); process.chdir(root);
  process.env.BIMAX_BREAKGLASS_DIR = path.join(destination, 'config');
  process.env.BIMAX_TRACE_DIR = path.join(root, '.bimax/traces');
  process.env.BIMAX_TRACE = '1'; process.env.BIMAX_RECORDER = '1';
  delete process.env.BIMAX_OTLP_ENDPOINT; delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const { AgentLoop } = await import('../core/agent.loop');
  const { ToolRegistry } = await import('../tools/tool.registry');
  const { createWriteFileTool } = await import('../tools/implementations/file.tool');
  const { createBashTool } = await import('../tools/implementations/bash.tool');
  const { getEpistemicLedger } = await import('./epistemic.ledger');
  const { getEventLedger } = await import('./event.ledger');
  const { getTaskRegistry, TaskRegistry } = await import('../core/task.registry');
  const { cliEvents } = await import('../cli/events');
  const { shutdownTracer } = await import('../telemetry/trace');
  const { mindSingletonRoot } = await import('./self.model');
  assert.strictEqual(mindSingletonRoot(), root);
  const testFile = 'src/claim.test.js';
  // The mutated file is the claim's subject. For 'green-unexecuted' it is deliberately a
  // module the passing run never loads, so the runner cannot attest it even though the
  // run is green — the case a command-argument scope would settle and attestation must not.
  const orphanClaim = mode === 'green-unexecuted' || mode === 'green-repo-wide';
  const file = orphanClaim ? 'src/orphan.js' : testFile;
  const trivial = "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('addition', () => assert.equal(1 + 1, 2));\n";
  const waiting = (assertion: string) => `const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('addition', async () => {
  await new Promise(resolve => {
    const ready = () => { if (fs.existsSync('release')) { watcher.close(); resolve(); } };
    const watcher = fs.watch('.', ready);
    ready();
  });
  ${assertion}
});
`;
  // The passing test NAMES the orphan path in its output without ever loading it: a
  // mention is not an execution, and a scope built from output text would settle it.
  const passing = waiting(orphanClaim
    ? "console.log('checked src/orphan.js'); assert.equal(1 + 1, 2);"
    : 'assert.equal(1 + 1, 2);');
  const after = isGreen ? passing : waiting('assert.equal(1 + 1, 3);');
  // 'green-unexecuted' mutates an orphan module, so the runnable test must already wait.
  fs.writeFileSync(testFile, orphanClaim ? passing : trivial);
  const orphanModule = "module.exports = { orphan: () => 'never loaded by the passing run' };\n";
  const written = orphanClaim ? orphanModule : after;
  // 'green-partial': TWO claims, one file the run executes and one it never loads, settled
  // by a path-less green command. Only per-file attestation can separate them; a repo-wide
  // green settle would mark both verified.
  const writes = mode === 'green-partial'
    ? [{ path: testFile, content: passing }, { path: 'src/orphan.js', content: orphanModule }]
    : [{ path: file, content: written }];
  // Both reporters to stdout: the stream then carries the test's own output (which names
  // a path it never loaded) alongside the runner's attestation of what actually executed.
  const coverage = '--experimental-test-coverage --test-reporter=tap --test-reporter-destination=stdout'
    + ' --test-reporter=lcov --test-reporter-destination=stdout';
  const command = mode === 'no-files' ? `node --test --bimax-invalid-option ${testFile}`
    : mode === 'green-repo-wide' || mode === 'green-partial' ? `node --test ${coverage}`
    : mode === 'green' || mode === 'green-unexecuted' ? `node --test ${coverage} ${testFile}`
    : `node --test --test-reporter=tap ${testFile}`;
  const governor = { async approveTaskExecution(kind: string, payload: { path?: string; command?: string }) {
    assert.ok((kind === 'FILE_WRITE' && writes.some(w => path.resolve(payload.path ?? '') === path.join(root, w.path)))
      || (kind === 'OS_COMMAND' && payload.command === command), 'unexpected proof operation');
  } };
  const registry = new ToolRegistry(); registry.register(createWriteFileTool(governor)); registry.register(createBashTool(governor));
  const actions = [...writes.map(w => ({ name: 'WriteFileTool', args: { path: w.path, content: w.content } })),
    { name: 'BashTool', args: { command, background: true } }];
  let round = 0;
  const provider: LLMProvider = { async *chat(): AsyncGenerator<ChatEvent> {
    const action = actions[round++];
    if (action) yield { type: 'tool_call', id: `bg-proof-${round}`, name: action.name, args: JSON.stringify(action.args) };
    else yield { type: 'token', text: 'Background task launched.' };
    yield { type: 'done' };
  } };
  const ledger = getEpistemicLedger();
  try {
    for await (const chunk of new AgentLoop(provider, registry).execute([{ role: 'user', content: 'Run isolated background evidence proof.' }],
      'Scripted actions, real tools.', { maxIterations: actions.length + 1 }, { cwd: root })) { void chunk; }
    const launched = ledger.stats();
    assert.strictEqual(launched.open, writes.length); assert.strictEqual(launched.resolved, 0, 'launch must not settle');
    const tasks = getTaskRegistry(); const task = tasks.list()[0]; assert.ok(task);
    const done = new Promise<void>(resolve => {
      const check = () => {
        if (['completed', 'failed-resumable', 'cancelled', 'failed'].includes(task.state)) {
          cliEvents.off('tasks_changed', check); resolve();
        }
      };
      cliEvents.on('tasks_changed', check); check();
    });
    if (mode === 'changed') fs.writeFileSync(file, after.replace('1 + 1, 3', '1 + 1, 4'));
    if (mode === 'cancel') tasks.cancel(task.id);
    else fs.writeFileSync('release', 'allow verification to finish');
    await done;
    ledger.saveNow(); await shutdownTracer();
    const events = getEventLedger().all();
    const claimed = events.find(e => e.type === 'claim');
    const evidence = events.filter(e => e.payload?.kind === 'background');
    assert.strictEqual(evidence.length, 1, 'one completion receipt');
    const completion = evidence[0];
    const settles = mode === 'named' || mode === 'green' || mode === 'green-partial';
    assert.strictEqual(ledger.stats().resolved, settles ? 1 : 0);
    assert.strictEqual(completion.payload.settled, settles ? 1 : 0);
    if (mode === 'named') {
      assert.ok(completion.payload.claimIds.includes(claimed!.payload.claimId));
      assert.ok(completion.payload.outputFiles.includes(file));
      assert.ok(tasks.output(task.id, TaskRegistry.OUTPUT_MAX_LINES).includes('ERR_ASSERTION')); // actual test, not just a path string
    }
    if (mode === 'no-files') assert.deepStrictEqual(completion.payload.outputFiles, []);
    if (mode === 'green') {
      assert.ok(completion.payload.claimIds.includes(claimed!.payload.claimId));
      assert.ok(completion.payload.attestedFiles.includes(file), 'the runner attested the claim file executed');
      assert.strictEqual(completion.payload.ok, true);
      assert.strictEqual(completion.payload.reason, null);
      // Confirmation, not refutation: the settled bucket must record the claim CORRECT.
      const row = ledger.calibration().find(r => r.n > 0);
      assert.ok(row && row.observed === 1, 'a green settlement records a correct claim');
    }
    if (orphanClaim) {
      assert.strictEqual(completion.payload.reason, 'attestation-covers-no-claim');
      assert.ok(completion.payload.attestedFiles.length > 0, 'the run attested something');
      assert.ok(!completion.payload.attestedFiles.includes(file), 'but never the claim file');
      // The passing output DID name the claim file. Only attestation separates the two.
      assert.ok(completion.payload.outputFiles.includes(file), 'green output mentioned the claim file');
    }
    if (mode === 'green-repo-wide') {
      const { commandPathTokens } = await import('./epistemic.ledger');
      assert.deepStrictEqual(commandPathTokens(command), [], 'a path-less command: the old rule would settle repo-wide');
    }
    if (mode === 'green-partial') {
      // The run executed one claimed file and never loaded the other.
      assert.deepStrictEqual(completion.payload.attestedFiles, [testFile]);
      assert.strictEqual(completion.payload.reason, null);
      assert.deepStrictEqual(completion.payload.coveredFiles, [testFile], 'only the executed claim settles');
      assert.strictEqual(ledger.stats().open, 1, 'the unexecuted claim stays open');
    }
    if (mode === 'green-no-coverage') {
      assert.strictEqual(completion.payload.reason, 'no-execution-attestation');
      assert.deepStrictEqual(completion.payload.attestedFiles, []);
    }
    const summary = { mode, scriptedActionsRealTools: true, claimFile: file, command, launched,
      completed: ledger.stats(), settled: completion.payload.settled, reason: completion.payload.reason,
      attestedFiles: completion.payload.attestedFiles, outputFiles: completion.payload.outputFiles, task,
      claimEventId: claimed?.id, completionEventId: completion.id, chain: getEventLedger().verifyChain(),
      limitation: 'Detached background spans use explicit origin links; strict tree attribution does not join them. File-level attestation does not prove the mutated LINES ran.' };
    fs.writeFileSync(path.join(destination, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(destination, 'events.json'), JSON.stringify(events, null, 2));
    fs.writeFileSync(path.join(destination, 'tool-output.txt'), tasks.output(task.id, TaskRegistry.OUTPUT_MAX_LINES));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    const tasks = getTaskRegistry();
    for (const task of tasks.live()) tasks.cancel(task.id);
    ledger.saveNow(); await shutdownTracer(); getEventLedger().close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
