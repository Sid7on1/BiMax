/**
 * Reproducible LIVE tool/sensor proof, not a model-quality evaluation or trace miner.
 * Usage: bun src/mind/learning.proof.ts <new-artifact-directory>
 * The provider scripts actions; actual tools edit disk and run the Node test runner.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import type { ChatEvent, LLMProvider } from '../core/llm.provider';

async function main() {
  const requested = process.argv[2];
  if (!requested) throw new Error('Usage: bun src/mind/learning.proof.ts <new-artifact-directory>');
  const artifact = path.resolve(requested);
  fs.mkdirSync(artifact); // fresh state or fail; never reuse a prior proof's observations
  const root = path.join(artifact, 'workspace');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  process.chdir(root);
  process.env.BIMAX_BREAKGLASS_DIR = path.join(artifact, 'config');
  process.env.BIMAX_TRACE_DIR = path.join(root, '.bimax', 'traces');
  process.env.BIMAX_TRACE = '1';
  process.env.BIMAX_RECORDER = '1';
  delete process.env.BIMAX_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const { AgentLoop } = await import('../core/agent.loop');
  const { ToolRegistry } = await import('../tools/tool.registry');
  const { createWriteFileTool } = await import('../tools/implementations/file.tool');
  const { createBashTool } = await import('../tools/implementations/bash.tool');
  const { getEpistemicLedger } = await import('./epistemic.ledger');
  const { getEventLedger } = await import('./event.ledger');
  const { shutdownTracer } = await import('../telemetry/trace');
  const { attributeTrace } = await import('./trace.attribution');
  const { CLAIM_TTL_MS } = await import('./epistemic.ledger');
  const { mindSingletonRoot } = await import('./self.model');
  assert.strictEqual(mindSingletonRoot(), root, 'learning must be isolated to this workspace');

  const file = 'src/claim.test.js';
  const initial = "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('addition', () => assert.equal(1 + 1, 2));\n";
  const changed = initial.replace('1 + 1, 2', '1 + 1, 3');
  fs.writeFileSync(file, initial);
  fs.writeFileSync(path.join(artifact, 'before.js'), initial);
  const command = `node --test --test-reporter=tap ${file}`;
  const noFiles = `node --test --bimax-invalid-option ${file}`;
  const governor = {
    async approveTaskExecution(kind: string, payload: { path?: string; command?: string }) {
      if (kind === 'FILE_WRITE' && path.resolve(payload.path || '') === path.join(root, file)) return;
      if (kind === 'OS_COMMAND' && (payload.command === command || payload.command === noFiles)) return;
      throw new Error(`Proof governor refused unexpected operation: ${kind}`);
    },
  };
  const registry = new ToolRegistry();
  registry.register(createWriteFileTool(governor));
  registry.register(createBashTool(governor));
  const actions = [
    { name: 'BashTool', args: { command } }, // actual passing baseline, no claims yet
    { name: 'WriteFileTool', args: { path: file, content: changed } },
    { name: 'BashTool', args: { command: noFiles } }, // red, names no files; cannot refute
    { name: 'BashTool', args: { command } }, // actual assertion failure names the changed file
  ];
  const states: ReturnType<ReturnType<typeof getEpistemicLedger>['stats']>[] = [];
  let round = 0;
  const provider: LLMProvider = {
    async *chat(): AsyncGenerator<ChatEvent> {
      states.push(getEpistemicLedger().stats());
      const action = actions[round++];
      if (action) yield { type: 'tool_call', id: `proof-${round}`, name: action.name, args: JSON.stringify(action.args) };
      else yield { type: 'token', text: 'Finished the prescribed real-tool sensor proof.' };
      yield { type: 'done' };
    },
  };
  try {
    const loop = new AgentLoop(provider, registry);
    for await (const _ of loop.execute([{ role: 'user', content: 'Run the prescribed isolated sensor proof.' }],
      'Deterministic tool-path proof; no model inference.', { maxIterations: actions.length + 1 }, { cwd: root })) { /* drain */ }
    getEpistemicLedger().saveNow();
    await shutdownTracer();
    const events = getEventLedger().all();
    const chain = getEventLedger().verifyChain();
    fs.writeFileSync(path.join(artifact, 'events.json'), JSON.stringify(events, null, 2));
    fs.writeFileSync(path.join(artifact, 'states.json'), JSON.stringify(states, null, 2));
    const spans = fs.readdirSync(process.env.BIMAX_TRACE_DIR!).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(process.env.BIMAX_TRACE_DIR!, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
    const attribution = attributeTrace(spans, Date.now(), CLAIM_TTL_MS);
    fs.writeFileSync(path.join(artifact, 'attribution.json'), JSON.stringify(attribution, null, 2));
    fs.writeFileSync(path.join(artifact, 'spans.jsonl'), spans.map(s => JSON.stringify(s)).join('\n') + '\n');
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.bimax', 'epistemic.json'), 'utf8'));
    const claims = events.filter(e => e.type === 'claim');
    const evidence = events.filter(e => e.type === 'evidence');
    const named = evidence.find(e => e.payload.settled > 0);
    const refusal = evidence.find(e => e.payload.command === noFiles);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), changed, 'real edit did not land');
    assert.strictEqual(claims.length, 1, 'exactly one real mutation must mint a claim');
    assert.strictEqual(claims[0].payload.after.open, 1);
    assert.strictEqual(refusal?.payload.ok, false);
    assert.deepStrictEqual(refusal?.payload.outputFiles, []);
    assert.strictEqual(refusal?.payload.settled, 0);
    assert.strictEqual(refusal?.payload.after.open, 1);
    assert.strictEqual(named?.payload.ok, false);
    assert.strictEqual(named?.payload.settled, 1);
    assert.strictEqual(named?.payload.after.open, 0);
    assert.strictEqual(named?.payload.after.resolved, 1);
    assert.deepStrictEqual(named?.payload.outputFiles.includes(file), true);
    assert.strictEqual(saved.open.length, 0);
    assert.strictEqual(saved.buckets.reduce((n: number, b: { n: number }) => n + b.n, 0), 1);
    const attributed = attribution.operations.filter(o => o.attribution === 'scoped-verification');
    assert.strictEqual(attributed.length, 1);
    assert.strictEqual(attributed[0].claim, 'refuted');
    assert.strictEqual(attributed[0].spanId, claims[0].payload.spanId);
    assert.strictEqual(attributed[0].evidenceSpanId, named?.payload.spanId);
    assert.ok(chain.ok && chain.events > 0);
    const summary = {
      property: 'real edit -> durable open claim -> no-file refusal -> actual named test failure -> durable refutation',
      source: 'scripted action selection; real AgentLoop, WriteFileTool, BashTool, Node test process and SQLite',
      modelInference: false, states, claimEventId: claims[0].id, evidenceEventId: named!.id,
      noFileEvidenceEventId: refusal!.id, chain,
      claims: { minted: claims.length, resolved: attributed.length, attributionFraction: attributed.length / claims.length },
      spans: { count: spans.length, attributed: attributed.length, attributionFraction: attributed.length / spans.length },
      fileBeforeSha256: crypto.createHash('sha256').update(initial).digest('hex'),
      fileAfterSha256: crypto.createHash('sha256').update(changed).digest('hex'),
      calibration: { ece: getEpistemicLedger().ece(), curve: getEpistemicLedger().isotonicCurve(), samples: 1 },
      limits: ['One deterministic real-tool trace, not model quality or a policy holdout experiment.',
        'Green diagnostic mention is not accepted for trace verification; background completions are not instrumented.'],
    };
    fs.writeFileSync(path.join(artifact, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    getEpistemicLedger().saveNow();
    await shutdownTracer();
    getEventLedger().close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
