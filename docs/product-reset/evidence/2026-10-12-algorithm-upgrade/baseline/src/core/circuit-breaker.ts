/**
 * Circuit breaker + retry policy.
 *
 * A faithful TypeScript transcription of xAI Grok Build's `xai-circuit-breaker` Rust crate
 * (Apache-2.0; see THIRD_PARTY_NOTICES.md). The sliding-window-with-min-samples algorithm, the
 * three-state machine (Closed / Open / HalfOpen), the half-open probe lease-reclaim, the config
 * presets/thresholds, and the RetryPolicy status classification are preserved exactly. The Rust
 * atomics / mutex / CAS machinery is intentionally dropped: Node is single-threaded, so a `record()`
 * or `check()` runs to completion without another thread observing an intermediate state — the data
 * races those primitives guard against cannot occur here.
 *
 * Purpose: a shared breaker sits in front of a flaky dependency (a local provider, an
 * LLM endpoint). Once the recent failure rate crosses a threshold it OPENS and sheds traffic for a
 * cool-down instead of hammering a dependency that is already failing; after the cool-down it admits
 * ONE probe (HalfOpen) and closes again on success or re-opens on failure.
 */

/** Tri-state circuit-breaker status. */
export enum BreakerState {
  Closed = 0,
  Open = 1,
  HalfOpen = 2,
}

/** Outcome of a guarded operation fed back to the breaker via {@link CircuitBreaker.record}. */
export enum Outcome {
  Success = 'success',
  Failure = 'failure',
}

/** Thrown/returned by {@link CircuitBreaker.check} when the breaker is shedding traffic. */
export class BreakerOpen extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`circuit breaker open; retry after ${(retryAfterMs / 1000).toFixed(1)}s`);
    this.name = 'BreakerOpen';
  }
}

/** Monotonic millisecond clock (injectable so tests can drive cool-down windows deterministically). */
export type Clock = () => number;
const systemClock: Clock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

const DEFAULT_FAILURE_CODES = [429, 500, 502, 503, 504];

export interface BreakerConfig {
  /** Sliding-window span; samples older than this are evicted before every trip check. */
  windowDurationMs: number;
  /** Minimum samples in the window before the breaker is allowed to trip. */
  minSamples: number;
  /** Failure fraction (0..1) at or above which the breaker trips once `minSamples` is met. */
  errorRateThreshold: number;
  /** Cool-down after tripping before a half-open probe is admitted. */
  openDurationMs: number;
  /** How many concurrent probes HalfOpen admits (min 1). */
  halfOpenMaxProbes: number;
  /** HTTP status codes treated as failures by {@link CircuitBreaker.isFailureStatus}. */
  failureCodes: Set<number>;
  enabled: boolean;
}

/** Default set of HTTP failure codes (429, 500, 502, 503, 504). */
export function defaultFailureCodes(): Set<number> {
  return new Set(DEFAULT_FAILURE_CODES);
}

/** Parse a comma-separated list of status codes; invalid entries are silently dropped. */
export function parseFailureCodes(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/**
 * Server preset: min_samples=10, error_rate=0.5, 60s window, 10s open, failure codes
 * [429,500,502,503,504]. Suits a shared server-side breaker (stricter trip, short cool-down).
 */
export function serverConfig(): BreakerConfig {
  return {
    windowDurationMs: 60_000,
    minSamples: 10,
    errorRateThreshold: 0.5,
    openDurationMs: 10_000,
    halfOpenMaxProbes: 1,
    failureCodes: defaultFailureCodes(),
    enabled: true,
  };
}

/**
 * Client preset: min_samples=5, error_rate=0.5, 60s window, 60s open, failure codes [401]. Suits
 * client-side breakers keyed per endpoint/tenant (fewer samples, longer cool-down).
 */
export function clientConfig(): BreakerConfig {
  return {
    windowDurationMs: 60_000,
    minSamples: 5,
    errorRateThreshold: 0.5,
    openDurationMs: 60_000,
    halfOpenMaxProbes: 1,
    failureCodes: new Set([401]),
    enabled: true,
  };
}

/** Load knobs from `<prefix>*` environment variables (default prefix `CB_`). */
export function configFromEnv(prefix = 'CB_', env: Record<string, string | undefined> = process.env): BreakerConfig {
  const num = (k: string, d: number): number => {
    const v = env[prefix + k];
    if (v == null) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = env[prefix + k];
    if (v == null) return d;
    return v === 'true' || v === '1';
  };
  let failureCodes = defaultFailureCodes();
  const rawCodes = env[prefix + 'FAILURE_CODES'];
  if (rawCodes != null) {
    const parsed = parseFailureCodes(rawCodes);
    if (parsed.size > 0) failureCodes = parsed;
  }
  return {
    windowDurationMs: num('WINDOW_SECS', 60) * 1000,
    minSamples: num('MIN_SAMPLES', 10),
    errorRateThreshold: num('ERROR_RATE_THRESHOLD', 0.5),
    openDurationMs: num('OPEN_DURATION_SECS', 10) * 1000,
    halfOpenMaxProbes: Math.max(1, num('HALF_OPEN_MAX_PROBES', 1)),
    failureCodes,
    enabled: bool('ENABLED', true),
  };
}

/**
 * Safety cap on sliding-window entries to bound memory under sustained high load (e.g. 10K req/s ×
 * 60s window would otherwise reach 600K entries).
 */
const MAX_WINDOW_ENTRIES = 10_000;

/**
 * Bounded sliding window over (timestamp, isFailure) samples. `failures` is maintained incrementally
 * on push/pop so `errorRate()` is O(1) instead of scanning the window on every request.
 */
class SlidingWindow {
  private entries: Array<{ at: number; isFailure: boolean }> = [];
  private failures = 0;

  push(isFailure: boolean, at: number): void {
    if (this.entries.length >= MAX_WINDOW_ENTRIES) {
      const dropped = this.entries.shift();
      if (dropped?.isFailure) this.failures--;
    }
    this.entries.push({ at, isFailure });
    if (isFailure) this.failures++;
  }

  evict(windowMs: number, now: number): void {
    const cutoff = now - windowMs;
    while (this.entries.length > 0 && this.entries[0].at < cutoff) {
      const dropped = this.entries.shift()!;
      if (dropped.isFailure) this.failures--;
    }
  }

  errorRate(): number {
    if (this.entries.length === 0) return 0;
    return this.failures / this.entries.length;
  }

  sampleCount(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.failures = 0;
  }
}

/** Telemetry hooks; all optional and all no-ops by default. */
export interface Observer {
  onStateChange?(from: BreakerState, to: BreakerState, reason: string): void;
  onOutcome?(outcome: Outcome, state: BreakerState): void;
  onProbeAdmission?(admitted: boolean): void;
}

/** Small fixed backoff advertised on a slot-exhausted HalfOpen rejection (capped to openDuration). */
const HALF_OPEN_PROBE_BACKOFF_MS = 50;

/**
 * The circuit-breaker state machine. `check()` before issuing a request; `record()` its outcome.
 */
export class CircuitBreaker {
  private readonly config: BreakerConfig;
  private readonly clock: Clock;
  private readonly observer: Observer;

  private stateVal: BreakerState = BreakerState.Closed;
  /** Millisecond offset (from `baseline`) at which the breaker last opened. */
  private openedAtMs = 0;
  /** How many half-open probe slots are currently claimed. */
  private halfOpenProbes = 0;
  /** When the most recent half-open probe slot was claimed (offset from `baseline`). */
  private probeClaimedAtMs = 0;
  private readonly baseline: number;
  private readonly window = new SlidingWindow();

  constructor(config: BreakerConfig = serverConfig(), opts: { clock?: Clock; observer?: Observer } = {}) {
    this.config = { ...config, halfOpenMaxProbes: Math.max(1, config.halfOpenMaxProbes) };
    this.clock = opts.clock ?? systemClock;
    this.observer = opts.observer ?? {};
    this.baseline = this.clock();
  }

  /**
   * Consult the breaker before issuing a request. Resolves (returns) when the request may proceed;
   * throws {@link BreakerOpen} when the breaker is currently shedding traffic.
   */
  check(): void {
    if (!this.config.enabled) return;
    switch (this.stateVal) {
      case BreakerState.Closed:
        return;
      case BreakerState.Open:
        this.checkOpen();
        return;
      case BreakerState.HalfOpen:
        this.tryHalfOpenProbe();
        return;
    }
  }

  /** Record the outcome of a request. */
  record(outcome: Outcome): void {
    if (!this.config.enabled) return;
    const isFailure = outcome === Outcome.Failure;
    const now = this.clock();
    const prev = this.stateVal;

    switch (prev) {
      case BreakerState.Closed: {
        this.window.push(isFailure, now);
        this.window.evict(this.config.windowDurationMs, now);
        const shouldTrip =
          this.window.sampleCount() >= this.config.minSamples &&
          this.window.errorRate() >= this.config.errorRateThreshold;
        if (shouldTrip) this.trip(prev, 'trip');
        break;
      }
      case BreakerState.HalfOpen:
        if (isFailure) this.trip(prev, 'probe_failure');
        else this.close(prev, 'probe_success');
        break;
      case BreakerState.Open:
        // Traffic that slipped through (or a probe recorded elsewhere) still feeds the window.
        this.window.push(isFailure, now);
        this.window.evict(this.config.windowDurationMs, now);
        break;
    }

    this.observer.onOutcome?.(outcome, this.stateVal);
  }

  /** Current authoritative state. */
  state(): BreakerState {
    return this.stateVal;
  }

  /** Is the breaker currently open (shedding traffic)? */
  isOpen(): boolean {
    return this.stateVal === BreakerState.Open;
  }

  /** Failure rate over the live sliding window (evicts stale samples first). */
  errorRate(): number {
    this.window.evict(this.config.windowDurationMs, this.clock());
    return this.window.errorRate();
  }

  /** `true` if `status` is in the configured failure-code set. */
  isFailureStatus(status: number): boolean {
    return this.config.failureCodes.has(status);
  }

  /** Force-transition to HalfOpen (bypasses the open-duration timer) — for tests. */
  forceHalfOpen(): void {
    const prev = this.stateVal;
    this.stateVal = BreakerState.HalfOpen;
    this.halfOpenProbes = 0;
    if (prev !== BreakerState.HalfOpen) this.observer.onStateChange?.(prev, BreakerState.HalfOpen, 'force_half_open');
  }

  private elapsedMs(): number {
    return Math.max(0, this.clock() - this.baseline);
  }

  private checkOpen(): void {
    const now = this.elapsedMs();
    const elapsed = now - this.openedAtMs;

    if (elapsed >= this.config.openDurationMs) {
      // Cool-down elapsed → transition to HalfOpen and route through the shared probe accounting.
      this.stateVal = BreakerState.HalfOpen;
      this.observer.onStateChange?.(BreakerState.Open, BreakerState.HalfOpen, 'open_elapsed');
      // Do NOT reset halfOpenProbes here — it is already 0 (zeroed on trip, untouched while Open).
      return this.tryHalfOpenProbe();
    }

    throw new BreakerOpen(Math.max(0, this.config.openDurationMs - elapsed));
  }

  private trip(prev: BreakerState, reason: string): void {
    this.stateVal = BreakerState.Open;
    this.openedAtMs = this.elapsedMs();
    this.halfOpenProbes = 0;
    if (prev !== BreakerState.Open) this.observer.onStateChange?.(prev, BreakerState.Open, reason);
  }

  private close(prev: BreakerState, reason: string): void {
    this.stateVal = BreakerState.Closed;
    this.window.clear();
    this.halfOpenProbes = 0;
    if (prev !== BreakerState.Closed) this.observer.onStateChange?.(prev, BreakerState.Closed, reason);
  }

  private tryHalfOpenProbe(): void {
    const now = this.elapsedMs();
    if (this.halfOpenProbes < this.config.halfOpenMaxProbes) {
      this.halfOpenProbes++;
      this.probeClaimedAtMs = now;
      this.observer.onProbeAdmission?.(true);
      return;
    }

    // All probe slots are claimed. A claim is only released via record(); if a probe's owner is
    // abandoned before recording (its promise is dropped mid-flight), the slot would be held forever
    // and the breaker could never leave HalfOpen. Treat a claim older than openDuration as abandoned
    // and let one caller take it over, so a lost probe delays recovery by at most one cool-down.
    const leaseMs = this.config.openDurationMs;
    if (now - this.probeClaimedAtMs >= leaseMs) {
      this.probeClaimedAtMs = now;
      this.observer.onProbeAdmission?.(true);
      return;
    }

    this.observer.onProbeAdmission?.(false);
    // Slot-exhausted rejection advertises a small fixed backoff, not the full cool-down.
    throw new BreakerOpen(Math.min(HALF_OPEN_PROBE_BACKOFF_MS, this.config.openDurationMs));
  }
}

/** What a caller should do with a non-2xx HTTP response, by status code. */
export enum Disposition {
  /** transient: retry with backoff (5xx, 429, etc.) */
  Retryable = 'retryable',
  /** refresh credentials once, then give up (e.g. 401) */
  AuthRefresh = 'auth-refresh',
  /** permanent: drop immediately, never retry (e.g. 400/403/404) */
  Terminal = 'terminal',
}

/**
 * Maps an HTTP status code to a {@link Disposition}, consolidating scattered "what should I do with
 * this response" logic. Transcribed from Grok's `RetryPolicy`.
 */
export class RetryPolicy {
  private constructor(
    private readonly retryable: readonly number[],
    private readonly authRefresh: readonly number[],
    private readonly terminal: readonly number[],
    private readonly fallback: Disposition,
  ) {}

  /** Classify `status`; returns `null` for 2xx (success, not an error). */
  classify(status: number): Disposition | null {
    if (status >= 200 && status < 300) return null;
    if (this.authRefresh.includes(status)) return Disposition.AuthRefresh;
    if (this.terminal.includes(status)) return Disposition.Terminal;
    if (this.retryable.includes(status) || (status >= 500 && status < 600)) return Disposition.Retryable;
    return this.fallback;
  }

  /** `true` iff `status` classifies as Retryable. */
  shouldRetry(status: number): boolean {
    return this.classify(status) === Disposition.Retryable;
  }

  /** Server preset: 429 and any 5xx are retryable, everything else terminal. */
  static server(): RetryPolicy {
    return new RetryPolicy([429], [], [], Disposition.Terminal);
  }

  /** Client storage/upload preset: 400/403/404 terminal, 401 auth-refresh, everything else retried. */
  static clientStorage(): RetryPolicy {
    return new RetryPolicy([], [401], [400, 403, 404], Disposition.Retryable);
  }
}

/**
 * Run `fn` guarded by a breaker with bounded exponential-backoff-with-jitter retries. Consults the
 * breaker first (throwing BreakerOpen without calling `fn` when shedding), records every outcome,
 * and stops retrying once attempts are exhausted or `shouldRetry` says the error is terminal.
 */
export async function withBreaker<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Decide whether a thrown error is worth retrying (default: retry everything). */
    shouldRetry?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    breaker.check(); // throws BreakerOpen when shedding — do not even attempt
    try {
      const result = await fn();
      breaker.record(Outcome.Success);
      return result;
    } catch (err) {
      breaker.record(Outcome.Failure);
      lastErr = err;
      if (attempt === maxAttempts - 1 || !shouldRetry(err)) break;
      // full-jitter exponential backoff
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(Math.round(random() * backoff));
    }
  }
  throw lastErr;
}
