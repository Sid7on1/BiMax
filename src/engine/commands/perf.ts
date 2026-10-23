import { globalCommandRegistry } from './registry';
import { perfSnapshot, PerfSnapshot } from '../../telemetry/perf';
import { guardTimings } from '../../tools/guard.timing';
import { performanceBudgetReport } from '../../telemetry/performance.budget';
import { slowWaitEvidence, describeAttribution } from '../../telemetry/netprobe';

/**
 * /perf — a hidden diagnostics readout of the engine's own performance: cold-start (process load →
 * ready), per-turn time-to-first-token (p50/p95), and memory. Pure local counters (see PRIVACY.md);
 * "you can't call it smooth without a number." Frame-level render metrics live in the Go TUI.
 */
export function renderPerf(s: PerfSnapshot): string {
  const ms = (n: number) => (n > 0 ? `${n} ms` : '—');
  const lines = [
    '● **Performance**',
    '',
    `  Cold start (load → ready):  **${ms(s.coldStartMs)}**` + (s.coldStartMs > 0 && s.coldStartMs < 300 ? '  ✓ < 300 ms' : ''),
    `  Uptime:                     ${Math.round(s.uptimeMs / 1000)} s`,
    `  Memory:                     ${s.rssMb} MB rss · ${s.heapMb} MB heap`,
    '',
    `  Turns measured:             ${s.turns}`,
    `  Time-to-first-token:        p50 ${ms(s.firstTokenP50)} · p95 ${ms(s.firstTokenP95)}`,
    '',
    `  Bimax overhead (ours):      p50 ${ms(s.overheadP50)} · p95 ${ms(s.overheadP95)}`,
    `  Provider wait (theirs):     p50 ${ms(s.providerWaitP50)} · p95 ${ms(s.providerWaitP95)}`,
    `  Render (payload→visible):   p95 ${ms(s.renderP95)}`,
    `  Greeting-lane overhead:     p95 ${ms(s.liteOverheadP95)}`,
  ];
  if (s.lastTurn) {
    lines.push(`  Last turn:                  first token ${ms(s.lastTurn.firstTokenMs)} · total ${ms(s.lastTurn.totalMs)} · ${s.lastTurn.streamedChars} streamed chars`);
  }
  if (s.lastBreakdown) {
    const b = s.lastBreakdown;
    lines.push(`  Last turn split:            ${b.lane} lane · overhead ${ms(b.overheadMs)} · provider ${ms(b.providerWaitMs)} · render ${ms(b.renderMs)}`);
  }

  if (s.providerRounds > 0) {
    // Characters are characters and tokens are tokens: a count the provider never reported reads
    // "unavailable", never 0, so an unmetered route can't look free.
    const tok = (n: number | null) => (n === null ? 'unavailable' : String(n));
    lines.push(
      '',
      `  Provider rounds:            ${s.providerRounds} · wait p50 ${ms(s.roundWaitP50)} · p95 ${ms(s.roundWaitP95)}`,
      `  Provider-reported usage:    ${s.roundsWithUsage}/${s.providerRounds} round(s) · ` +
      `in ${tok(s.providerInputTokens)} · out ${tok(s.providerOutputTokens)} · cached-in ${tok(s.providerCachedInputTokens)}`,
    );
  }

  lines.push('', '  Performance budgets:');
  for (const check of performanceBudgetReport(s)) {
    const state = !check.measured ? '○ unmeasured' : check.pass ? '✓ pass' : '✗ over';
    lines.push(`    ${check.metric.padEnd(20)} ${state} · ${check.value || '—'} / ${check.budget} ${check.unit}`);
  }

  try {
    const snapshot = require('../../outcome/outcome.manager').getOutcomeManager().snapshot();
    if (snapshot) {
      const schedule = snapshot.schedule;
      lines.push('', '  Active outcome:');
      lines.push(`    elapsed                  ${ms(snapshot.elapsedMs)}`);
      lines.push(`    time to verified         ${snapshot.timeToVerifiedMs ? ms(snapshot.timeToVerifiedMs) : 'in progress'}`);
      lines.push(`    estimated parallel save  ${ms(schedule.estimatedParallelSavingsMs)}`);
      lines.push(`    remaining critical path  ${ms(schedule.estimatedCriticalPathMs)}`);
    }
  } catch { /* /perf also works before the outcome runtime starts */ }

  // Slow-wait attribution: every long first-token wait triggered a background DNS→TCP→TLS probe
  // of the provider origin, so a stall is attributed from EVIDENCE, never assumption.
  const waits = slowWaitEvidence();
  if (waits.length > 0) {
    lines.push('', '  Slow-wait evidence (most recent first):');
    for (const w of waits.slice(0, 5)) {
      const when = new Date(w.at).toLocaleTimeString();
      const phases = w.probe.ok || w.probe.failedPhase
        ? `dns ${w.probe.dnsMs}ms · tcp ${w.probe.tcpMs}ms · tls ${w.probe.tlsMs}ms${w.probe.failedPhase ? ` · ${w.probe.failedPhase} FAILED` : ''}`
        : 'probe failed';
      lines.push(`    ${when}  waited ${Math.round(w.waitedMs / 1000)}s${w.timedOut ? ' (timed out)' : ''} on ${w.origin}`);
      lines.push(`      ${phases} → ${describeAttribution(w.attribution)}`);
    }
  }

  // WS5 step 3 — guard pipeline timing. Shows whether tool latency is spent in the guards
  // (governor approval, hooks) or in the tool itself, so a slow guard is caught, not blamed.
  const guards = guardTimings();
  if (guards.length > 0) {
    lines.push('', '  Guard pipeline (this session):');
    for (const g of guards) {
      lines.push(`    ${g.phase.padEnd(18)} ${g.count}× · avg ${g.avgMs.toFixed(1)} ms · max ${g.maxMs} ms · total ${Math.round(g.totalMs)} ms`);
    }
  }
  return lines.join('\n');
}

globalCommandRegistry.register({
  name: '/perf',
  description: 'Engine perf readout — cold start, time-to-first-token, memory',
  category: 'Code & Intelligence',
  hidden: true, // diagnostics, not an everyday verb — reachable when typed
  execute: async () => ({ type: 'message', level: 'info', content: renderPerf(perfSnapshot()) }),
});
