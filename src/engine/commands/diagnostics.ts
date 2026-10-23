import * as os from 'os';
import { globalCommandRegistry } from './registry';
import { getConfig } from '../config';
import { buildKeyPool, getCurrentProvider } from '../provider';
import { capabilitiesFor, capabilityGlyphs } from '../../core/capabilities';
import { globalTelemetry } from '../../telemetry/telemetry';
import { taskMetrics } from '../../telemetry/task.metrics';
import * as headroomProxy from '../../memory/headroomProxy';
import { getHeadroomReport } from '../../memory/headroom.compress';
import { globalMcpManager } from '../../mcp/manager';
import { getSelfModel } from '../../mind/self.model';
import { getEpistemicLedger } from '../../mind/epistemic.ledger';
import { getDrivesEngine } from '../../mind/drives.engine';

// One actionable health line. status drives the glyph; detail says what to do when not OK.
function healthLine(status: 'ok' | 'warn' | 'fail', label: string, detail: string): string {
  const glyph = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
  return `- ${glyph} ${label}: ${detail}`;
}

// The real failure modes a user hits — surfaced as pass/warn/fail so "it's broken" becomes actionable.
// Decoupled on purpose: reads the same key pool / proxy singleton / report the engine uses, no DI.
function healthChecks(): string[] {
  const lines: string[] = ['', '**Health checks**'];

  // API keys — an empty pool is why requests silently fail.
  try {
    const keys = buildKeyPool();
    lines.push(keys.length > 0
      ? healthLine('ok', 'API keys', `${keys.length} key(s) · provider ${getCurrentProvider()}`)
      : healthLine('fail', 'API keys', 'none configured — set one in /config or the provider env var'));
  } catch (e: any) {
    lines.push(healthLine('warn', 'API keys', `could not read key pool (${e?.message})`));
  }

  // Headroom compression — live proxy vs. native fallback vs. still provisioning.
  try {
    const r = getHeadroomReport();
    if (headroomProxy.isHeadroomReady?.()) {
      lines.push(healthLine('ok', 'Compression', `Kompress proxy live · ${r.totalSaved.toLocaleString()} tok saved this session`));
    } else if (r.totalSaved > 0) {
      lines.push(healthLine('warn', 'Compression', `native fallback (proxy still provisioning) · ${r.totalSaved.toLocaleString()} tok saved`));
    } else {
      lines.push(healthLine('warn', 'Compression', 'Kompress proxy provisioning — native fallback until ready'));
    }
    // Guard the report invariant the "100% → 0 tok" bug violated, in case it ever regresses live.
    if (r.totalSaved > 0 && r.totalAfter <= 0) {
      lines.push(healthLine('fail', 'Compression math', 'report shows after=0 — this is the old "100% smaller" bug; please report it'));
    }
  } catch (e: any) {
    lines.push(healthLine('warn', 'Compression', `unavailable (${e?.message})`));
  }

  // MCP connectors — no network probe here (keep /diagnostics instant); /mcp doctor performs the
  // active five-second-bounded probe when a connector needs deeper inspection.
  try {
    const statuses = globalMcpManager.health();
    const active = statuses.filter(s => s.state !== 'disabled');
    const broken = active.filter(s => s.state === 'error' || s.state === 'disconnected');
    if (!statuses.length) {
      lines.push(healthLine('warn', 'Integrations', 'none configured — use /mcp to add one'));
    } else if (broken.length) {
      lines.push(healthLine('fail', 'Integrations', `${broken.map(s => s.name).join(', ')} need attention — run /mcp doctor`));
    } else {
      lines.push(healthLine('ok', 'Integrations', `${active.length} connected · ${statuses.length - active.length} disabled`));
    }
  } catch (e: any) {
    lines.push(healthLine('warn', 'Integrations', `status unavailable (${e?.message})`));
  }

  return lines;
}

// A one-glance strip of the mind layer: weak spots, calibration gaps, drive deviations.
// Full detail lives in /self; this just says whether the agent's self-knowledge is clean.
function mindLines(): string[] {
  const lines: string[] = ['', '**Mind (self-knowledge)**'];
  try {
    const weak = getSelfModel().weakSpots();
    const t = getSelfModel().totals();
    lines.push(weak.length === 0
      ? healthLine('ok', 'Self-model', t.calls > 0 ? `${t.calls} outcomes learned · no weak spots` : 'building — no outcomes yet')
      : healthLine('warn', 'Self-model', `${weak.length} weak spot(s) — routing hints active (see /self)`));
  } catch { /* best-effort */ }
  try {
    const over = getEpistemicLedger().overconfidentDomains();
    lines.push(over.length === 0
      ? healthLine('ok', 'Calibration', 'no overconfidence gap detected')
      : healthLine('warn', 'Calibration', `overconfident in ${over.map(o => o.domain).join(', ')} — verification escalated`));
  } catch { /* best-effort */ }
  try {
    const dev = getDrivesEngine().deviations();
    lines.push(dev.length === 0
      ? healthLine('ok', 'Drives', 'no fresh deviations (measure with /drives check)')
      : healthLine('fail', 'Drives', `${dev.map(d => d.label).join(', ')} — run /dream or fix directly`));
  } catch { /* best-effort */ }
  return lines;
}

function fmtDuration(totalSec: number): string {
  const s = Math.floor(totalSec % 60);
  const m = Math.floor((totalSec / 60) % 60);
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const MB = (bytes: number) => Math.round(bytes / 1024 / 1024);
const GB = (bytes: number) => (bytes / 1024 / 1024 / 1024).toFixed(1);

// Diagnostics dashboard (`/diagnostics`) — a one-glance health report for the running session. The
// telemetry exists (memory monitor / watchdog / metrics) but was invisible to the user; this
// surfaces process + system health and the active model's capabilities in plain markdown. Spend is
// in /cost and context usage in /context, so this points there rather than duplicating them.
globalCommandRegistry.register({
  name: '/diagnostics',
  aliases: ['/diag', '/health'],
  category: 'Configuration',
  description: 'Session health — memory, uptime, system & active model capabilities',
  execute: async (_args, _context) => {
    const mem = process.memoryUsage();
    let model = 'default';
    let liteModel = '';
    try { const c = getConfig(); model = c.model || 'default'; liteModel = c.liteModel || ''; } catch { /* config not loaded */ }
    const caps = capabilitiesFor(undefined, model);
    const glyphs = capabilityGlyphs(caps);

    // Tool latency telemetry
    const toolStats = globalTelemetry.getToolStats();
    const cacheStats = globalTelemetry.getCacheStats();

    const toolLines: string[] = [];
    if (toolStats.length > 0) {
      toolLines.push('', '**Tool latency (this session)**');
      const header = `${'Tool'.padEnd(28)} ${'Calls'.padStart(5)} ${'Avg'.padStart(6)} ${'Min'.padStart(6)} ${'p95'.padStart(6)} ${'Max'.padStart(6)}`;
      toolLines.push('```', header);
      for (const s of toolStats.slice(0, 12)) {
        const name = s.name.slice(0, 27).padEnd(28);
        toolLines.push(`${name} ${String(s.count).padStart(5)} ${(s.avgMs + 'ms').padStart(6)} ${(s.minMs + 'ms').padStart(6)} ${(s.p95Ms + 'ms').padStart(6)} ${(s.maxMs + 'ms').padStart(6)}`);
      }
      toolLines.push('```');
    }

    // Per-task counters (Phase 10.1). Medians, and interrupted tasks excluded — see
    // src/telemetry/task.metrics.ts for why neither of those is cosmetic.
    const taskLines: string[] = [];
    const taskSummary = taskMetrics.summarize();
    if (taskSummary.length > 0) {
      taskLines.push('', '**Turns per task (this session, medians)**');
      const header = `${'Surface'.padEnd(20)} ${'Tasks'.padStart(5)} ${'Turns'.padStart(6)} ${'Tools'.padStart(6)} ${'Prompt tok'.padStart(11)}`;
      taskLines.push('```', header);
      for (const s of taskSummary.slice(0, 12)) {
        const name = (s.label ? `${s.surface}/${s.label}` : s.surface).slice(0, 19).padEnd(20);
        taskLines.push(`${name} ${String(s.tasks).padStart(5)} ${String(s.medianTurns).padStart(6)} ${String(s.medianToolCalls).padStart(6)} ${s.medianPromptTokens.toLocaleString().padStart(11)}`);
      }
      taskLines.push('```');
      if (process.env.BIMAX_TASK_METRICS !== '1') {
        taskLines.push('_Set `BIMAX_TASK_METRICS=1` to also append each task to `.breakglass/metrics/task-runs.jsonl`._');
      }
    }

    const cacheLines: string[] = [];
    if (cacheStats.totalPrompt > 0) {
      cacheLines.push('', '**Prompt cache (Anthropic)**');
      cacheLines.push(`- Cache hit rate: ${cacheStats.hitRate} (${cacheStats.readTokens.toLocaleString()} read / ${cacheStats.totalPrompt.toLocaleString()} prompt tokens)`);
      if (cacheStats.creationTokens > 0) cacheLines.push(`- Written to cache: ${cacheStats.creationTokens.toLocaleString()} tokens`);
    }

    const lines = [
      '## Diagnostics',
      '',
      '**Process**',
      `- Memory (RSS): ${MB(mem.rss)} MB · heap ${MB(mem.heapUsed)}/${MB(mem.heapTotal)} MB${mem.external ? ` · external ${MB(mem.external)} MB` : ''}`,
      `- Uptime: ${fmtDuration(process.uptime())}`,
      `- Node ${process.version} · ${process.platform} ${process.arch} · pid ${process.pid}`,
      '',
      '**System**',
      `- Memory: ${GB(os.totalmem() - os.freemem())} / ${GB(os.totalmem())} GB used`,
      `- CPUs: ${os.cpus().length} · load ${os.loadavg().map(n => n.toFixed(2)).join(' / ')}`,
      '',
      '**Active model**',
      `- Coding: ${model.split('/').pop()}${liteModel ? ` · Lite: ${liteModel.split('/').pop()}` : ''}`,
      `- Context window: ${caps.contextWindow.toLocaleString()} tokens`,
      `- Capabilities: ${glyphs || '(floor — no special capabilities)'}`,
      ...healthChecks(),
      ...mindLines(),
      ...toolLines,
      ...taskLines,
      ...cacheLines,
      '',
      '_Spend → /cost · context usage → /context · plugins → /plugins · safety → /security · self-knowledge → /self_',
    ];

    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/trace',
  category: 'Session & Context',
  description: 'Recent agent/LLM/tool trace spans (OTel GenAI) + export locations',
  execute: async () => {
    // Deferred require keeps command registration free of trace-module init order concerns.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getTracer } = require('../../telemetry/trace') as typeof import('../../telemetry/trace');
    const tracer = getTracer();
    if (!tracer.isEnabled()) {
      return { type: 'message', level: 'info', content: 'Tracing is disabled (BIMAX_TRACE=0). Unset it to record spans.' };
    }
    const spans = tracer.recentSpans().slice(-25).reverse();
    const dur = (s: { startTimeUnixNano: string; endTimeUnixNano: string }) =>
      `${(Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6).toFixed(0)}ms`;
    const rows = spans.map(s => {
      const glyph = s.status === 'error' ? '✗' : '✓';
      const extra = [
        s.attributes['gen_ai.usage.input_tokens'] != null ? `in ${s.attributes['gen_ai.usage.input_tokens']} tok` : '',
        s.attributes['gen_ai.usage.output_tokens'] != null ? `out ${s.attributes['gen_ai.usage.output_tokens']} tok` : '',
        s.attributes['bimax.claim.confidence'] != null ? `claim conf ${s.attributes['bimax.claim.confidence']}` : '',
        s.attributes['bimax.tool.error_class'] ? `err ${s.attributes['bimax.tool.error_class']}` : '',
      ].filter(Boolean).join(' · ');
      return `- ${glyph} ${s.name} · ${dur(s)}${extra ? ` · ${extra}` : ''}`;
    });
    const otlp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.BIMAX_OTLP_ENDPOINT;
    const lines = [
      '## Trace — OTel GenAI spans (newest first)',
      '',
      ...(rows.length ? rows : ['_No spans yet this session — run a prompt first._']),
      '',
      `- JSONL export: ${tracer.exportPath()}`,
      otlp ? `- OTLP export: ${otlp}/v1/traces` : '- OTLP export: off — set OTEL_EXPORTER_OTLP_ENDPOINT to stream spans to a collector',
    ];
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});
