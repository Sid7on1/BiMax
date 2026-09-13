import { randomBytes } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';

/**
 * Measurement primitives for the F01 critical-path instrumentation and the P01 evaluation harness.
 *
 * `perf.ts` answers "how did the last turn split?" for `/perf`. This module answers the question
 * P01 actually asks: for one identified task, turn, attempt and round, where did the time go, what
 * did it cost, and which stages did not happen at all. Three rules make the answers trustworthy:
 *
 *  1. **Unavailable is null, never zero.** A stage that never ran, a clock that was never read and
 *     a provider that never reported usage are all `null`. `serializeSpan` refuses to emit a number
 *     for a stage that did not happen, because a zero in a distribution is a lie that averages.
 *  2. **A character count is not a token count.** Streamed characters live in `streamedChars`.
 *     Token fields only carry numbers when `usage.source === 'provider'`, and the serializer
 *     rejects any other combination. There is no code path that promotes one into the other.
 *  3. **No prompt, source or credential text.** Attribute values are scalars, and a string that
 *     looks like free text — too long, or containing a newline — is replaced with a redaction
 *     marker and counted. Records are bounded, so a long session cannot grow without limit.
 *
 * Nothing here writes to disk or the network. Persistence and reporting belong to the caller.
 */

export type AttrValue = string | number | boolean;

/** Longer than this, or containing a newline, is treated as free text and redacted. */
export const MAX_ATTR_CHARS = 200;
export const REDACTED = '<redacted:free-text>';

export type SpanKind = 'task' | 'turn' | 'attempt' | 'round' | 'stage';

export interface TokenUsage {
  /**
   * `provider` — the numbers below came from the provider's own usage report.
   * `unavailable` — the provider did not report usage. Every field is then null; it is never
   * back-filled from an estimate, a tokenizer guess or a character count.
   */
  source: 'provider' | 'unavailable';
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
}

export const USAGE_UNAVAILABLE: TokenUsage = Object.freeze({
  source: 'unavailable',
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheCreationTokens: null,
});

export function providerUsage(u: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
}): TokenUsage {
  return {
    source: 'provider',
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens ?? null,
    cacheCreationTokens: u.cacheCreationTokens ?? null,
  };
}

export interface ResourceSample {
  atMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  /** Mean event-loop delay since the last sample, or null when the platform monitor is unavailable. */
  eventLoopDelayMs: number | null;
  /** Max event-loop delay since the last sample, or null when unavailable. */
  eventLoopDelayMaxMs: number | null;
}

export interface SpanRecord {
  id: string;
  parentId: string | null;
  taskId: string;
  turnId: string | null;
  attemptId: string | null;
  kind: SpanKind;
  name: string;
  /** Monotonic milliseconds since the recorder was created. */
  startMs: number;
  /** Null while the span is still open. Never coerced to a number. */
  endMs: number | null;
  durationMs: number | null;
  attributes: Record<string, AttrValue>;
  /** How many attribute values were redacted for looking like free text. */
  redactedAttributes: number;
  usage: TokenUsage;
  /** Streamed characters. Deliberately not a token count; see the module note. */
  streamedChars: number | null;
  resourcesAtEnd: ResourceSample | null;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

// --- event-loop delay -----------------------------------------------------------------------------

let elMonitor: ReturnType<typeof monitorEventLoopDelay> | null | undefined;
function eventLoopMonitor() {
  if (elMonitor === undefined) {
    try {
      elMonitor = monitorEventLoopDelay({ resolution: 10 });
      elMonitor.enable();
    } catch {
      elMonitor = null; // not available on this runtime; the sample reports null rather than 0
    }
  }
  return elMonitor;
}

/**
 * Sample this process's resources. Event-loop delay is read from the histogram accumulated since
 * the previous sample and then reset, so consecutive samples describe disjoint windows.
 * Whole-process-tree RSS is deliberately NOT collected here — it needs to spawn `ps`, which does not
 * belong on an instrumented hot path. The evaluation harness collects it around a run instead.
 */
export function sampleResources(): ResourceSample {
  const mem = process.memoryUsage();
  const mon = eventLoopMonitor();
  let mean: number | null = null;
  let max: number | null = null;
  if (mon) {
    try {
      // `mean` is NaN until the histogram has a sample; NaN must not become 0.
      const m = mon.mean / 1e6;
      const x = mon.max / 1e6;
      mean = Number.isFinite(m) ? m : null;
      max = Number.isFinite(x) ? x : null;
      mon.reset();
    } catch {
      mean = null;
      max = null;
    }
  }
  return {
    atMs: Date.now(),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
    eventLoopDelayMs: mean,
    eventLoopDelayMaxMs: max,
  };
}

// --- serialization guards --------------------------------------------------------------------------

export class MeasurementIntegrityError extends Error {}

/**
 * Reject a record that would misreport what was measured. This is the gate that makes
 * "relabel unavailable timing as zero" and "present a character count as token usage" fail loudly
 * instead of quietly producing a plausible number.
 */
export function serializeSpan(span: SpanRecord): SpanRecord {
  if (span.endMs === null && span.durationMs !== null) {
    throw new MeasurementIntegrityError(`span ${span.name} has a duration but never ended`);
  }
  if (span.endMs !== null && span.durationMs === null) {
    throw new MeasurementIntegrityError(`span ${span.name} ended without a duration`);
  }
  if (span.durationMs !== null && span.durationMs < 0) {
    throw new MeasurementIntegrityError(`span ${span.name} has a negative duration`);
  }
  const tokenFields = [
    span.usage.inputTokens,
    span.usage.outputTokens,
    span.usage.cachedInputTokens,
    span.usage.cacheCreationTokens,
  ];
  if (span.usage.source === 'unavailable' && tokenFields.some(v => v !== null)) {
    throw new MeasurementIntegrityError(
      `span ${span.name} reports token counts the provider never supplied; unavailable usage must stay null`
    );
  }
  if (span.usage.source === 'provider' && (span.usage.inputTokens === null || span.usage.outputTokens === null)) {
    throw new MeasurementIntegrityError(
      `span ${span.name} claims provider usage without input/output token counts`
    );
  }
  return { ...span, attributes: { ...span.attributes } };
}

function sanitizeAttr(value: AttrValue): { value: AttrValue; redacted: boolean } {
  if (typeof value !== 'string') return { value, redacted: false };
  if (value.length > MAX_ATTR_CHARS || value.includes('\n')) return { value: REDACTED, redacted: true };
  return { value, redacted: false };
}

// --- recorder ---------------------------------------------------------------------------------------

export interface SpanHandle {
  readonly id: string;
  readonly taskId: string;
  readonly turnId: string | null;
  readonly attemptId: string | null;
  /** Open a child span. `turn`, `attempt` and `round` kinds establish their own id for descendants. */
  child(kind: SpanKind, name: string, attributes?: Record<string, AttrValue>): SpanHandle;
  setAttributes(attributes: Record<string, AttrValue>): void;
  setUsage(usage: TokenUsage): void;
  setStreamedChars(chars: number): void;
  /** Idempotent: a second end() is ignored, so a try/finally double-end is safe. */
  end(attributes?: Record<string, AttrValue>): void;
  readonly ended: boolean;
}

export interface RecorderOptions {
  /** Maximum retained spans. Oldest are dropped first; the drop count is reported. */
  maxSpans?: number;
  /** Sample process resources when a span ends. Default true. */
  sampleOnEnd?: boolean;
}

export class MeasurementRecorder {
  private readonly base = performance.now();
  private readonly maxSpans: number;
  private readonly sampleOnEnd: boolean;
  private records: SpanRecord[] = [];
  private dropped = 0;

  constructor(options: RecorderOptions = {}) {
    this.maxSpans = options.maxSpans ?? 2000;
    this.sampleOnEnd = options.sampleOnEnd !== false;
  }

  private now(): number { return performance.now() - this.base; }

  startTask(name: string, attributes: Record<string, AttrValue> = {}): SpanHandle {
    return this.open(null, 'task', name, attributes, newId('task'), null, null);
  }

  /** Every span retained so far, oldest first, each passed through the integrity guard. */
  snapshot(): SpanRecord[] {
    return this.records.map(serializeSpan);
  }

  /** Spans that are still open — a stage that never finished is visible, not silently absent. */
  openSpans(): SpanRecord[] {
    return this.records.filter(r => r.endMs === null).map(serializeSpan);
  }

  droppedSpans(): number { return this.dropped; }

  reset(): void {
    this.records = [];
    this.dropped = 0;
  }

  private open(
    parent: SpanRecord | null,
    kind: SpanKind,
    name: string,
    attributes: Record<string, AttrValue>,
    taskId: string,
    turnId: string | null,
    attemptId: string | null,
  ): SpanHandle {
    const record: SpanRecord = {
      id: newId(kind),
      parentId: parent?.id ?? null,
      taskId,
      turnId,
      attemptId,
      kind,
      name,
      startMs: this.now(),
      endMs: null,
      durationMs: null,
      attributes: {},
      redactedAttributes: 0,
      usage: USAGE_UNAVAILABLE,
      streamedChars: null,
      resourcesAtEnd: null,
    };
    this.push(record);
    // Arrow properties, so the handle closes over the recorder lexically rather than aliasing `this`.
    const handle: SpanHandle = {
      id: record.id,
      taskId: record.taskId,
      turnId: record.turnId,
      attemptId: record.attemptId,
      get ended() { return record.endMs !== null; },
      child: (childKind, childName, childAttrs) => this.open(
        record,
        childKind,
        childName,
        childAttrs ?? {},
        record.taskId,
        childKind === 'turn' ? newId('turn') : record.turnId,
        childKind === 'attempt' ? newId('attempt') : record.attemptId,
      ),
      setAttributes: attrs => { this.apply(record, attrs); },
      setUsage: usage => { record.usage = usage; },
      setStreamedChars: chars => { record.streamedChars = chars; },
      end: attrs => {
        if (record.endMs !== null) return;
        if (attrs) this.apply(record, attrs);
        record.endMs = this.now();
        record.durationMs = Math.max(0, record.endMs - record.startMs);
        if (this.sampleOnEnd) record.resourcesAtEnd = sampleResources();
      },
    };
    this.apply(record, attributes);
    return handle;
  }

  private apply(record: SpanRecord, attrs: Record<string, AttrValue>): void {
    for (const [key, raw] of Object.entries(attrs)) {
      const { value, redacted } = sanitizeAttr(raw);
      record.attributes[key] = value;
      if (redacted) record.redactedAttributes++;
    }
  }

  private push(record: SpanRecord): void {
    this.records.push(record);
    while (this.records.length > this.maxSpans) {
      this.records.shift();
      this.dropped++;
    }
  }
}

/** Process-wide recorder for the engine's own spans. Tests construct their own instance. */
export const globalMeasurements = new MeasurementRecorder();
