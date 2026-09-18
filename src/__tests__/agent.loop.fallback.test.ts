import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { LLMProvider, ChatEvent } from '../core/llm.provider';

// A successful failover PERSISTS the new model, so these tests must never see the developer's real
// ~/.breakglass/config.json. Without this they rewrite it — which is exactly what happened once:
// a test run silently repointed a real machine's `model` at the catalog default.
let tmpBreakglass: string;
const realBreakglassDir = process.env.BIMAX_BREAKGLASS_DIR;
beforeAll(() => {
  tmpBreakglass = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-fallback-cfg-'));
  process.env.BIMAX_BREAKGLASS_DIR = tmpBreakglass;
});
afterAll(() => {
  if (realBreakglassDir === undefined) delete process.env.BIMAX_BREAKGLASS_DIR;
  else process.env.BIMAX_BREAKGLASS_DIR = realBreakglassDir;
  try { fs.rmSync(tmpBreakglass, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Model fallback chain (the Claude Code `fallbackModel` analogue): when the active model keeps
 * failing — transient retry budget exhausted, or a hard provider rejection — the loop switches
 * the session to the configured fallback model ONCE and re-asks, instead of dying mid-run.
 */
describe('AgentLoop — fallback model chain', () => {
  afterEach(() => {
    delete process.env.BIMAX_FALLBACK_MODEL;
    delete process.env.BIMAX_DESKTOP_STRICT_MODEL;
  });

  it('never retries or fails over when Desktop locks the exact model', async () => {
    process.env.BIMAX_DESKTOP_STRICT_MODEL = 'stepfun-ai/step-3.7-flash';
    process.env.BIMAX_FALLBACK_MODEL = 'backup-model';
    const { llm, applied } = makeFailoverLlm({ type: 'error', message: 'stream stalled', recoverable: true, kind: 'transient' });
    let calls = 0;
    const original = (llm as any).chat.bind(llm);
    (llm as any).chat = async function* (...args: any[]) { calls++; yield* original(...args); };

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    let out = '';
    for await (const token of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) out += token;

    expect(calls).toBe(1);
    expect(applied).toEqual([]);
    expect(out).toContain('provider returned an error');
  });

  // An LLM whose chat() fails until applyConfig() switches the model, then succeeds.
  function makeFailoverLlm(failWith: ChatEvent) {
    const applied: any[] = [];
    let model = 'primary-model';
    const llm = {
      userModel: 'primary-model',
      applyConfig(cfg: any) {
        applied.push(cfg);
        if (cfg.model) { model = cfg.model; (llm as any).userModel = cfg.model; }
      },
      async *chat(): AsyncGenerator<ChatEvent> {
        if (model === 'primary-model') {
          yield failWith;
        } else {
          yield { type: 'token', text: `Answered on ${model}.` };
          yield { type: 'done' };
        }
      },
    };
    return { llm: llm as unknown as LLMProvider, applied };
  }

  it('fails over after the transient budget is exhausted and completes on the fallback', async () => {
    process.env.BIMAX_FALLBACK_MODEL = 'backup-model';
    const { llm, applied } = makeFailoverLlm({ type: 'error', message: 'stream stalled', recoverable: true, kind: 'transient' });

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) {
      out += t;
    }

    expect(applied).toEqual([{ model: 'backup-model' }]);
    expect(out).toContain('Answered on backup-model.');
    expect(out).not.toContain('provider returned an error');
  }, 15000); // rides through 2 real backoff sleeps (~3s) before the failover

  it('fails over immediately on a hard (unrecoverable) provider rejection', async () => {
    process.env.BIMAX_FALLBACK_MODEL = 'backup-model';
    const { llm, applied } = makeFailoverLlm({ type: 'error', message: 'model decommissioned', recoverable: false } as ChatEvent);

    const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) {
      out += t;
    }

    expect(applied).toEqual([{ model: 'backup-model' }]);
    expect(out).toContain('Answered on backup-model.');
  });

  it('fires only once — a failing fallback surfaces the error instead of ping-ponging', async () => {
    process.env.BIMAX_FALLBACK_MODEL = 'backup-model';
    let calls = 0;
    const llm = {
      userModel: 'primary-model',
      applyConfig(cfg: any) { if (cfg.model) (llm as any).userModel = cfg.model; },
      async *chat(): AsyncGenerator<ChatEvent> {
        calls++;
        // Both models are down.
        yield { type: 'error', message: 'everything is on fire', recoverable: false } as ChatEvent;
      },
    };

    const loop = new AgentLoop(llm as unknown as LLMProvider, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) {
      out += t;
    }

    expect(calls).toBe(2); // primary once, fallback once — then surfaced, never spun
    expect(out).toContain('The provider returned an error');
  });

  // Failing over is the machine picking a model on the user's behalf, so it must obey the same
  // safety policy as healing. The live failure this encodes: the configured fallback was
  // stepfun-ai/step-3.7-flash, which sends no response headers for 180s — so a visible model error
  // turned into a spinner that never resolved and a turn that never replied.
  describe('never fails over to a model that cannot serve the turn', () => {
    const hardFail: ChatEvent = { type: 'error', message: 'model decommissioned', recoverable: false } as ChatEvent;

    it('skips a fallback the provider already rejected this session', async () => {
      process.env.BIMAX_FALLBACK_MODEL = 'known-dead-model';
      const { llm, applied } = makeFailoverLlm(hardFail);
      // The adapter learned this id is a lie (listed by /models, 404s on completion).
      (llm as any).isUnservable = (id: string) => id === 'known-dead-model';
      (llm as any).listProviderModels = async () => [];

      const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
      for await (const _ of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) { /* drain */ }

      expect(applied.map(a => a.model)).not.toContain('known-dead-model');
    });

    it('HONORS a configured fallback the catalog bars from automatic selection', async () => {
      // This asserted the opposite until 2026-09-02, and the assertion was the bug. `avoidAutoSelect`
      // gates the models the machine may pick BY ITSELF; BIMAX_FALLBACK_MODEL is a value the user
      // set. Letting the flag override it discarded a configured `nemotron-3.5-lightning-30b-a3b`
      // (6.7s, calls tools) for carrying the note "task probe pending", and derived a replacement
      // the provider does not serve — turning a working fallback into a dead turn.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MODEL_CATALOG } = require('../engine/models') as typeof import('../engine/models');
      const avoided = MODEL_CATALOG.find(m => m.avoidAutoSelect)!.value;
      process.env.BIMAX_FALLBACK_MODEL = avoided;
      const { llm, applied } = makeFailoverLlm(hardFail);
      (llm as any).listProviderModels = async () => [];

      const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
      for await (const _ of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) { /* drain */ }

      expect(applied.map(a => a.model)).toContain(avoided);
    });

    it('derives a served model when the configured fallback is disqualified BY EVIDENCE', async () => {
      // The other half of the split: once the provider has actually rejected the configured value,
      // it is disqualified and derivation takes over — and derivation DOES respect the catalogue
      // bar, so it must not land on the avoided model even though the provider serves it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MODEL_CATALOG, autoSelectCandidates } = require('../engine/models') as typeof import('../engine/models');
      const avoided = MODEL_CATALOG.find(m => m.avoidAutoSelect)!.value;
      // Ask the policy which model it would pick, rather than restating the rule with a different one.
      const good = autoSelectCandidates('coding', MODEL_CATALOG.map(m => m.value))[0];
      process.env.BIMAX_FALLBACK_MODEL = avoided;
      const { llm, applied } = makeFailoverLlm(hardFail);
      (llm as any).isUnservable = (id: string) => id === avoided;
      (llm as any).listProviderModels = async () => [avoided, good];

      const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
      let out = '';
      for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) out += t;

      expect(applied.map(a => a.model)).toEqual([good]);
      expect(out).toContain(`Answered on ${good}.`);
    });
  });

  it('does not fail over to the model that is already active', async () => {
    process.env.BIMAX_FALLBACK_MODEL = 'primary-model'; // same as current
    let applies = 0;
    const llm = {
      userModel: 'primary-model',
      applyConfig() { applies++; },
      async *chat(): AsyncGenerator<ChatEvent> {
        yield { type: 'error', message: 'down', recoverable: false } as ChatEvent;
      },
    };

    const loop = new AgentLoop(llm as unknown as LLMProvider, new ToolRegistry(), null as any);
    let out = '';
    for await (const t of loop.execute([{ role: 'user', content: 'go' }], 'sys', { maxIterations: 10 })) {
      out += t;
    }

    expect(applies).toBe(0);
    expect(out).toContain('The provider returned an error');
  });
});
