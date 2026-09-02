#!/usr/bin/env node
// Live greeting-lane measurement (P0-2 + P0-3 verification). Drives the SAME adapter call the lite
// conversation lane uses — `chat()` with a conversational system prompt and NO tools — against the
// real configured provider/model, N times, and reports the honest split: Bimax overhead vs provider
// wait vs render, plus a streaming proof (did visible tokens arrive in more than one delta before
// stream end, or all at once?). Requires a provider key in the environment / ~/.breakglass/.env.
//
// Usage: node scripts/measure-greeting.mjs [runs] [prompt]
import { LlmAdapter } from '../dist/core/llm.adapter.js';
import { ApiKeyManager } from '../dist/credits/api.key.manager.js';
import { loadGlobalEnv } from '../dist/cli/env.loader.js';
import { buildKeyPool } from '../dist/cli/provider.js';
import * as perf from '../dist/telemetry/perf.js';

const RUNS = parseInt(process.argv[2] || '10', 10);
const PROMPT = process.argv[3] || 'hi';
const MODEL = process.env.BGW_MODEL || 'mistralai/mistral-7b-instruct-v0.3';
const SYSTEM =
  'You are BiMax, an autonomous coding agent in the BiMax terminal. Right now you are making brief ' +
  'conversation. Reply in one or two natural sentences. Do not mention tools.';

loadGlobalEnv();
process.env.BIMAX_PERF_PERSIST = '0';
const keys = buildKeyPool();
if (keys.length === 0) {
  console.error('No provider key found (NVIDIA_API_KEY / OPENAI_API_KEY). Cannot run a live measurement.');
  process.exit(2);
}

const adapter = new LlmAdapter(new ApiKeyManager(keys));
adapter.applyConfig({ model: MODEL });
adapter.setKeys(keys);

function pct(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0; }

const rows = [];
for (let i = 0; i < RUNS; i++) {
  perf.beginTurnTimeline('lite', MODEL);
  perf.markRouted();
  perf.markAssembled();
  const t0 = performance.now();
  let firstVisible = 0, chunks = 0, chars = 0, thinkingChars = 0;
  try {
    for await (const ev of adapter.chat([{ role: 'user', content: PROMPT }], { system: SYSTEM, lite: false })) {
      if (ev.type === 'token' && ev.text) {
        chunks++; chars += ev.text.length;
        if (!firstVisible) { firstVisible = performance.now() - t0; perf.markFirstVisibleToken(); }
      } else if (ev.type === 'thinking') {
        thinkingChars += ev.text.length; // proves reasoning was diverted, not shown
      } else if (ev.type === 'error') {
        console.error(`run ${i + 1} error event:`, ev.message, '(recoverable:', ev.recoverable, ')');
      }
    }
  } catch (e) {
    console.error(`run ${i + 1} failed:`, e?.message || e);
    perf.endTurnTimeline();
    continue;
  }
  const b = perf.endTurnTimeline();
  rows.push({ run: i + 1, ttfvMs: Math.round(firstVisible), totalMs: b.totalMs, provider: b.providerWaitMs, render: b.renderMs, chunks, chars, thinkingChars });
}

console.log(`\nLive greeting measurement — model=${MODEL}, prompt=${JSON.stringify(PROMPT)}, runs=${rows.length}\n`);
console.log('run |  ttfv |  provider | render | total | chunks | ansChars | hiddenCoT');
for (const r of rows) {
  console.log(
    `${String(r.run).padStart(3)} | ${String(r.ttfvMs).padStart(5)} | ${String(r.provider).padStart(8)} | ${String(r.render).padStart(6)} | ${String(r.totalMs).padStart(5)} | ${String(r.chunks).padStart(6)} | ${String(r.chars).padStart(8)} | ${String(r.thinkingChars).padStart(9)}`,
  );
}
const totals = rows.map(r => r.totalMs).sort((a, b) => a - b);
const ttfvs = rows.map(r => r.ttfvMs).sort((a, b) => a - b);
const overhead = perf.perfSnapshot();
const streamedCount = rows.filter(r => r.chunks > 1).length;
console.log('\nAggregates:');
console.log(`  total       p50 ${pct(totals, 0.5)}ms · p95 ${pct(totals, 0.95)}ms`);
console.log(`  ttf-visible p50 ${pct(ttfvs, 0.5)}ms · p95 ${pct(ttfvs, 0.95)}ms`);
console.log(`  bimax overhead p95 ${overhead.overheadP95}ms · render p95 ${overhead.renderP95}ms · provider wait p95 ${overhead.providerWaitP95}ms`);
console.log(`  streamed incrementally (>1 visible delta): ${streamedCount}/${rows.length} runs  ← P0-2 streaming proof`);
