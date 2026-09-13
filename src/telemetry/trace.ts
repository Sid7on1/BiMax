import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

/**
 * Trace layer — OpenTelemetry GenAI semantic-convention spans, zero external dependencies.
 *
 * Every agent turn produces a small span tree following the OTel GenAI conventions
 * (gen_ai.operation.name = invoke_agent | chat | execute_tool, gen_ai.usage.*, gen_ai.tool.name),
 * so any OTLP backend (Jaeger, Datadog, Honeycomb, Grafana) can ingest BiMax traces unchanged:
 *
 *   invoke_agent bimax                 ← one per AgentLoop.execute()
 *   ├── chat {model}                   ← one per LLM round (tokens, finish reason)
 *   │   ├── execute_tool {tool}        ← one per tool call (outcome, error class, claim confidence)
 *   │   └── execute_tool {tool}
 *   └── invoke_agent {subAgentType}    ← one per sub-agent spawn (lifetime, outcome)
 *
 * Exporters (both best-effort, never on the hot path's critical section):
 *   • JSONL  — every ended span appends one line to .bimax/traces/YYYY-MM-DD.jsonl (always on).
 *   • OTLP   — when OTEL_EXPORTER_OTLP_ENDPOINT (or BIMAX_OTLP_ENDPOINT) is set, batches are
 *              POSTed as OTLP/HTTP JSON to {endpoint}/v1/traces every 5s / 64 spans.
 *
 * BIMAX_TRACE=0 disables everything (no-op spans, zero I/O). BIMAX_TRACE_DIR overrides the
 * JSONL directory (tests point it at a tmpdir).
 */

export type AttrValue = string | number | boolean | string[];

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface EndedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttrValue>;
  status: 'ok' | 'error' | 'unset';
  statusMessage?: string;
}

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttrValue): void;
  setAttributes(attrs: Record<string, AttrValue>): void;
  /** Idempotent — a second end() is ignored, so try/finally double-ends are safe. */
  end(status?: 'ok' | 'error', statusMessage?: string): void;
}

const NOOP_SPAN: Span = {
  context: { traceId: '', spanId: '' },
  setAttribute() { /* disabled */ },
  setAttributes() { /* disabled */ },
  end() { /* disabled */ },
};

function nowNano(): string {
  // Millisecond wall clock is plenty for agent-scale spans; OTLP wants nanoseconds as a string.
  return `${Date.now()}000000`;
}

function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

class LiveSpan implements Span {
  readonly context: SpanContext;
  private readonly startNano = nowNano();
  private ended = false;
  private attrs: Record<string, AttrValue>;

  constructor(
    private tracer: Tracer,
    private name: string,
    attrs: Record<string, AttrValue>,
    private parentSpanId?: string,
    traceId?: string
  ) {
    this.context = { traceId: traceId ?? hexId(16), spanId: hexId(8) };
    this.attrs = { ...attrs };
  }

  setAttribute(key: string, value: AttrValue): void {
    if (!this.ended) this.attrs[key] = value;
  }

  setAttributes(attrs: Record<string, AttrValue>): void {
    if (!this.ended) Object.assign(this.attrs, attrs);
  }

  end(status: 'ok' | 'error' = 'ok', statusMessage?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.onSpanEnd({
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTimeUnixNano: this.startNano,
      endTimeUnixNano: nowNano(),
      attributes: this.attrs,
      status,
      ...(statusMessage ? { statusMessage: statusMessage.slice(0, 500) } : {}),
    });
  }
}

/** OTLP/HTTP JSON encoding of a span batch (resourceSpans → scopeSpans → spans). */
export function toOtlpJson(spans: EndedSpan[], serviceName = 'bimax'): object {
  const attrList = (attrs: Record<string, AttrValue>) =>
    Object.entries(attrs).map(([key, v]) => ({
      key,
      value:
        Array.isArray(v) ? { arrayValue: { values: v.map(value => ({ stringValue: value })) } }
        : typeof v === 'number'
          ? Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
          : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
    }));
  const CODE = { ok: 'STATUS_CODE_OK', error: 'STATUS_CODE_ERROR', unset: 'STATUS_CODE_UNSET' } as const;
  return {
    resourceSpans: [{
      resource: { attributes: attrList({ 'service.name': serviceName }) },
      scopeSpans: [{
        scope: { name: 'bimax.trace', version: '1' },
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: s.startTimeUnixNano,
          endTimeUnixNano: s.endTimeUnixNano,
          attributes: attrList(s.attributes),
          status: { code: CODE[s.status], ...(s.statusMessage ? { message: s.statusMessage } : {}) },
        })),
      }],
    }],
  };
}

const OTLP_BATCH_MAX = 64;
const OTLP_FLUSH_MS = 5000;

export class Tracer {
  private readonly enabled: boolean;
  private readonly otlpEndpoint: string | null;
  private otlpBuffer: EndedSpan[] = [];
  private otlpTimer: NodeJS.Timeout | null = null;
  private jsonlDirEnsured = false;
  private pendingWrites = new Set<Promise<void>>();
  private closed = false;
  // Recent-span ring for /trace + tests — capped so a day-long session can't grow it unbounded.
  private recent: EndedSpan[] = [];
  private static readonly RECENT_MAX = 200;

  constructor() {
    this.enabled = process.env.BIMAX_TRACE !== '0';
    this.otlpEndpoint =
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.BIMAX_OTLP_ENDPOINT || null;
  }

  isEnabled(): boolean { return this.enabled; }

  startSpan(name: string, attrs: Record<string, AttrValue> = {}, parent?: SpanContext): Span {
    if (!this.enabled) return NOOP_SPAN;
    return new LiveSpan(this, name, attrs, parent?.spanId, parent?.traceId);
  }

  /** Last N ended spans, newest last (drives /trace and tests). */
  recentSpans(): EndedSpan[] { return [...this.recent]; }

  private jsonlDir(): string {
    return process.env.BIMAX_TRACE_DIR || path.join(process.cwd(), '.bimax', 'traces');
  }

  /** Today's JSONL export file (for surfacing the path to the user). */
  exportPath(): string {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.jsonlDir(), `${day}.jsonl`);
  }

  onSpanEnd(span: EndedSpan): void {
    if (this.closed) return;
    this.recent.push(span);
    if (this.recent.length > Tracer.RECENT_MAX) this.recent.splice(0, this.recent.length - Tracer.RECENT_MAX);

    // JSONL exporter — async append, best-effort. One small line per span; agent-scale span
    // rates (a handful per turn) make this negligible I/O.
    try {
      const dir = this.jsonlDir();
      if (!this.jsonlDirEnsured) {
        fs.mkdirSync(dir, { recursive: true });
        this.jsonlDirEnsured = true;
      }
      const write = fs.promises.appendFile(this.exportPath(), JSON.stringify(span) + '\n')
        .catch(() => undefined);
      this.pendingWrites.add(write);
      void write.then(() => this.pendingWrites.delete(write));
    } catch { /* tracing must never break the agent */ }

    // OTLP exporter — buffered; flushed on size or timer.
    if (this.otlpEndpoint) {
      this.otlpBuffer.push(span);
      if (this.otlpBuffer.length >= OTLP_BATCH_MAX) {
        void this.flushOtlp();
      } else if (!this.otlpTimer) {
        this.otlpTimer = setTimeout(() => void this.flushOtlp(), OTLP_FLUSH_MS);
        this.otlpTimer.unref?.();
      }
    }
  }

  async flushOtlp(): Promise<void> {
    if (this.otlpTimer) { clearTimeout(this.otlpTimer); this.otlpTimer = null; }
    if (!this.otlpEndpoint || this.otlpBuffer.length === 0) return;
    const batch = this.otlpBuffer;
    this.otlpBuffer = [];
    try {
      const url = this.otlpEndpoint.replace(/\/$/, '') + '/v1/traces';
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toOtlpJson(batch)),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e: any) {
      // Drop the batch — the JSONL file still has every span, so nothing is lost locally.
      Logger.warn(`[Trace] OTLP export failed (${e?.message}); spans remain in ${this.exportPath()}`);
    }
  }

  /** Stop accepting spans and drain local/remote exporters for a clean process or test teardown. */
  async shutdown(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled([...this.pendingWrites]);
      return;
    }
    this.closed = true;
    if (this.otlpTimer) { clearTimeout(this.otlpTimer); this.otlpTimer = null; }
    await Promise.allSettled([...this.pendingWrites]);
    await this.flushOtlp();
  }
}

let _tracer: Tracer | null = null;

/** Process-wide tracer. Lazy so env overrides set in tests (BIMAX_TRACE_DIR) are honored. */
export function getTracer(): Tracer {
  if (!_tracer) _tracer = new Tracer();
  return _tracer;
}

/** Flush and drop the singleton so the next getTracer() re-reads the environment. */
export async function resetTracerForTests(): Promise<void> {
  const previous = _tracer;
  _tracer = null;
  await previous?.shutdown();
}

/** Flush the existing singleton without creating one solely for shutdown. */
export async function shutdownTracer(): Promise<void> { await _tracer?.shutdown(); }
